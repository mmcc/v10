import { resolve } from 'node:path';

import {
  bundleStyles,
  collectModules,
  type Graph,
  type GraphModule,
  relativeImport,
  renderHtml,
  rewriteImports,
  stripStyleImports,
} from 'vjsc/graph';
import type { StyleTransformOptions } from 'vjsc/styles';

import type { SkinModuleMeta } from '../src/meta.ts';
import { skinClassNameMergeImport } from './imports.ts';
import type { GeneratedPackageFile } from './packages/files.ts';
import { createHtmlSkinRegistration, htmlTemplateModule } from './packages/html.ts';
import { reactFrameworkImport } from './packages/react.ts';
import { addGenerated, generatedFiles } from './packages/utils.ts';
import { htmlComponentTarget } from './target/html.tsx';
import type { SkinFramework, SkinStyling } from './variants.ts';

/**
 * The MoQ Publisher skin. It compiles through the same VJSC graph as the published skins, but stays out of
 * `skinStyles`, the catalog, and the registry: those describe upstream's playback skins, and the Publisher ships only
 * as the HTML and React package CSS skins.
 */
export const publisherSkinName = 'default-publisher';

const sourceDir = resolve(import.meta.dirname, '../src');
const publisherRoot = resolve(sourceDir, 'presets/publisher/skin.tsx');
const publisherBaseStylesheet = './presets/publisher/base.css';
const publisherScope = '.media-skin[data-theme="default"][data-preset="publisher"]';
const stylesDir = resolve(sourceDir, 'styles');

/** One compilation of the Publisher skin source; every module it reaches inherits this query. */
export interface PublisherVariant {
  readonly target: SkinFramework;
  readonly style: SkinStyling;
  readonly theme: 'default';
  readonly skin: typeof publisherSkinName;
}

/** Whether a source module is the Publisher skin entry that the package build compiles. */
export function isPublisherEntry(filename: string): boolean {
  return filename === publisherRoot;
}

/** The package build compiles CSS only; the sandbox compiles Tailwind from the authored source on request. */
export function publisherEntryParams(): readonly Readonly<Record<string, string>>[] {
  return (['html', 'react'] as const).map((target) => ({
    target,
    style: 'css',
    theme: 'default',
    skin: publisherSkinName,
  }));
}

/** Read a Publisher variant from a module's transform query, or `null` when the query selects another skin. */
export function parsePublisherVariant(parameters: URLSearchParams): PublisherVariant | null {
  if (parameters.get('skin') !== publisherSkinName || parameters.get('theme') !== 'default') return null;

  const target = parameters.get('target');
  const style = parameters.get('style');
  if ((target !== 'react' && target !== 'html') || (style !== 'tailwind' && style !== 'css')) return null;

  return { target, style, theme: 'default', skin: publisherSkinName };
}

export function publisherStyleOptions(variant: PublisherVariant): StyleTransformOptions {
  const variants = variant.target === 'html' ? ['default', 'shadow-dom'] : ['default'];
  const input = resolve(stylesDir, 'tailwind.compiler.css');

  return variant.style === 'tailwind'
    ? { mode: 'tailwind', variants, stylesheet: { input } }
    : {
        mode: 'css',
        variants,
        stylesheet: { input, base: resolve(sourceDir, publisherBaseStylesheet), scope: publisherScope },
      };
}

/** Generate the HTML template, registration, and styles, and the React modules, for the Publisher package skins. */
export async function createPublisherPackageSkins(graph: Graph<SkinModuleMeta>): Promise<GeneratedPackageFile[]> {
  const generated = new Map<string, string>();

  await Promise.all([addHtmlSkin(graph, generated), addReactSkin(graph, generated)]);

  return generatedFiles(generated);
}

/** Paths the Publisher generator writes outside the roots the published skins already own. */
export function publisherPackageSkinOwnedPaths(): string[] {
  return ['packages/react/src/presets/publisher/skin.tsx', 'packages/react/src/presets/publisher/skin.css'];
}

async function addHtmlSkin(graph: Graph<SkinModuleMeta>, generated: Map<string, string>): Promise<void> {
  const root = publisherRootModule(graph, 'html');
  const modules = collectModules(graph, root.id);
  const render = htmlComponentTarget.render ?? {};
  const templates = await renderHtml(
    graph,
    [{ name: publisherSkinName, moduleId: root.id, exportName: 'PublisherSkin' }],
    {
      aliases: render.aliases,
      empty: render.empty,
      modules: render.modules?.(modules),
    }
  );
  const template = templates.get(publisherSkinName);
  if (template === undefined) throw new Error('The HTML Publisher skin did not render a template.');

  const directory = `packages/html/src/internal/skins/${publisherSkinName}`;

  addGenerated(generated, `${directory}/template.ts`, htmlTemplateModule(template));
  addGenerated(generated, `${directory}/register.ts`, createHtmlSkinRegistration(template, modules, 'package'));
  addGenerated(generated, `${directory}/skin.css`, await publisherStyles(graph, modules));
}

async function addReactSkin(graph: Graph<SkinModuleMeta>, generated: Map<string, string>): Promise<void> {
  const root = publisherRootModule(graph, 'react');
  const modules = collectModules(graph, root.id);
  const destinations = new Map(modules.map((module) => [module.id, reactModulePath(module)]));

  for (const module of modules) {
    const destination = destinations.get(module.id)!;
    const source = rewriteImports(graph, module, ({ dependency, reference }) => {
      if (reference.specifier === skinClassNameMergeImport) return '@videojs/utils/style';

      const frameworkImport = reactFrameworkImport(reference.specifier);
      if (frameworkImport) return relativeImport(destination, frameworkImport);

      if (!dependency) return undefined;

      const target = destinations.get(dependency.id);
      if (!target) throw new Error(`Publisher skin dependency has no generated target: \`${dependency.sourcePath}\`.`);

      return relativeImport(destination, target);
    });

    addGenerated(generated, destination, stripStyleImports(source));
  }

  const publicRoot = 'packages/react/src/presets/publisher';

  addGenerated(
    generated,
    `${publicRoot}/skin.tsx`,
    reactSkinWrapper(relativeImport(`${publicRoot}/skin.tsx`, destinations.get(root.id)!))
  );
  addGenerated(generated, `${publicRoot}/skin.css`, await publisherStyles(graph, modules));
}

function publisherRootModule(graph: Graph<SkinModuleMeta>, target: SkinFramework): GraphModule<SkinModuleMeta> {
  const root = [...graph.modules.values()].find(
    (module) =>
      module.filename === publisherRoot &&
      module.params.target === target &&
      module.params.style === 'css' &&
      module.params.skin === publisherSkinName
  );
  if (!root) throw new Error(`The ${target} Publisher skin root is missing from the VJSC graph.`);

  return root;
}

function publisherStyles(graph: Graph<SkinModuleMeta>, modules: readonly GraphModule<SkinModuleMeta>[]) {
  return bundleStyles(graph, modules, {
    label: publisherSkinName,
    files: [publisherBaseStylesheet],
    // Packaged skins reach browsers without `@scope`.
    flattenScopes: true,
  });
}

/**
 * Every Publisher module gets its own copy under the skin's directory. The published skins share modules across one
 * another, but the Publisher compiles under its own query, so its copies of shared components differ from theirs.
 */
function reactModulePath(module: GraphModule<SkinModuleMeta>): string {
  const owned = 'presets/publisher/';
  const path = module.sourcePath.startsWith(owned) ? module.sourcePath.slice(owned.length) : module.sourcePath;

  return `packages/react/src/internal/skins/${publisherSkinName}/${path}`;
}

function reactSkinWrapper(importSource: string): string {
  return `'use client';

import { PublisherSkin as Skin } from '${importSource}';

import type { BaseSkinProps } from '../types';

export interface PublisherSkinProps extends BaseSkinProps {}

export function PublisherSkin(props: PublisherSkinProps) {
  return <Skin {...props} />;
}
`;
}
