/**
 * MSF catalog parsing (draft-ietf-moq-msf-01 §5) — the MoQ analog of
 * `parse-multivariant`.
 *
 * The catalog is a JSON document delivered as its own MoQ track. Parsing
 * is two-staged:
 *
 * 1. `applyMoqCatalogUpdate` — maintain the current `MoqCatalog` track
 *    list across independent catalogs and delta updates (§5.1.6/§5.3).
 * 2. `moqCatalogToPresentation` — project the catalog onto the shared
 *    CMAF-HAM model (`Presentation` → `SelectionSet` → `SwitchingSet` →
 *    live tracks), which the reused track-selection machinery consumes
 *    unchanged.
 *
 * Track ids are derived from full track names (namespace + name), NOT
 * `generateId()` like the HLS parser: live catalog updates re-parse into
 * a fresh `Presentation`, and stable ids are what let track-switching's
 * candidate-set equality treat an unchanged track list as unchanged.
 */
import { isPlainObject, isString } from '@videojs/utils/predicate';
import type {
  AudioSelectionSet,
  LiveAudioTrack,
  LiveTextTrack,
  LiveVideoTrack,
  MaybeResolvedPresentation,
  Presentation,
  SelectionSet,
  TextSelectionSet,
  VideoSelectionSet,
} from '../types';
import { encodeNamespaceName, parseMoqSource } from './parse-source';

// ============================================================================
// Catalog model
// ============================================================================

/** Parsed MSF track-object fields the engine consumes (§5.2). */
export interface MoqCatalogTrack {
  namespace: string[];
  name: string;
  packaging: string;
  isLive: boolean;
  role?: string;
  label?: string;
  language?: string;
  codec?: string;
  mimeType?: string;
  bitrate?: number;
  avgBitrate?: number;
  width?: number;
  height?: number;
  framerate?: number;
  timescale?: number;
  samplerate?: number;
  channelConfig?: string;
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  /**
   * Publisher-declared minimum buffer in milliseconds (msf-01 §5.2.9) —
   * the packaging/encode jitter a receiver has to absorb even on a perfect
   * path. Read by the adaptive latency controller as one additive term of
   * its margin; unused by the fixed-setpoint chain.
   */
  jitter?: number;
  buffers?: { target?: number; min?: number; max?: number };
  maxGopDuration?: number;
  maxGroupDuration?: number;
  temporalId?: number;
  spatialId?: number;
  dependencies?: string[];
  /** Decoder init data (`description`), resolved from initRef/initDataList. */
  initData?: Uint8Array;
  authInfo?: Record<string, unknown>;
}

export interface MoqCatalog {
  version: string;
  generatedAt?: number;
  isComplete?: boolean;
  tracks: MoqCatalogTrack[];
  /** Retained init-data map so delta-added tracks can resolve initRef (§5.3). */
  initDataList?: Map<string, Uint8Array>;
}

/** Fields of the moq-specific side-channel carried on each live track. */
export interface MoqTrackFields {
  namespace: string[];
  name: string;
  packaging: string;
  isLive: boolean;
  timescale?: number;
  framerate?: number;
  renderGroup?: number;
  altGroup?: number;
  targetLatency?: number;
  /** Publisher-declared minimum buffer in milliseconds (msf-01 §5.2.9). */
  jitter?: number;
  buffers?: { target?: number; min?: number; max?: number };
  maxGopDuration?: number;
  maxGroupDuration?: number;
  dependencies?: string[];
  initData?: Uint8Array;
  authInfo?: Record<string, unknown>;
  /**
   * Raw audio values as published (§5.2.20-21), carried verbatim so their
   * *absence* survives the projection. `AudioTrack.sampleRate`/`channels`
   * are required numbers, so the projection has to substitute conventional
   * values there; `codec-mapping` needs to tell a declared rate from a
   * substituted one to avoid configuring a decoder at the wrong rate.
   */
  samplerate?: number;
  channelConfig?: string;
}

export type MoqVideoTrack = LiveVideoTrack & { moq: MoqTrackFields };
export type MoqAudioTrack = LiveAudioTrack & { moq: MoqTrackFields };
export type MoqTextTrack = LiveTextTrack & { moq: MoqTrackFields };
export type MoqTrack = MoqVideoTrack | MoqAudioTrack | MoqTextTrack;

/** Serialized full track name — the stable track id within a presentation. */
export function moqTrackId(namespace: readonly string[], name: string): string {
  return [...namespace, name].join('/');
}

// ============================================================================
// Variable substitution (§5.4)
// ============================================================================

const VARIABLE_PATTERN = /%([a-zA-Z0-9_-]+)%/g;
const SAFE_VARIABLE_VALUE = /^[a-zA-Z0-9_\-@]*$/;

/**
 * Substitute `%name%` references in every string value of a parsed catalog
 * with fragment-parameter values. Values outside the safe charset are
 * rejected (injection guard, §5.4.1). Unknown variables are left in place.
 */
function substituteVariables(value: unknown, variables: Record<string, string>): unknown {
  if (isString(value)) {
    return value.replace(VARIABLE_PATTERN, (match, name: string) => {
      const substitution = variables[name];
      if (substitution === undefined) return match;
      if (!SAFE_VARIABLE_VALUE.test(substitution)) {
        throw new Error(`unsafe MSF variable value for ${name}`);
      }
      return substitution;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteVariables(entry, variables));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substituteVariables(entry, variables)])
    );
  }
  return value;
}

// ============================================================================
// Raw JSON → MoqCatalogTrack
// ============================================================================

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Split a catalog namespace string into its tuple fields. */
function parseNamespaceString(namespace: string): string[] {
  // The MSF catalog examples carry namespaces as path-like strings
  // ("conference.example.com/conference123/alice"); the tuple fields are
  // the path segments. (Interop check pending — the encoding of tuple
  // boundaries inside catalog JSON is not spelled out by msf-01.)
  return namespace.split('/').filter((field) => field.length > 0);
}

interface RawCatalog {
  version?: unknown;
  generatedAt?: unknown;
  isComplete?: unknown;
  tracks?: unknown;
  publishTracks?: unknown;
  deltaUpdate?: unknown;
  initDataList?: unknown;
}

function parseInitDataList(raw: unknown): Map<string, Uint8Array> {
  const initData = new Map<string, Uint8Array>();
  if (!Array.isArray(raw)) return initData;
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { id, type, data } = entry;
    if (!isString(id) || !isString(data)) continue;
    if (type !== undefined && type !== 'inline') continue;
    initData.set(id, base64ToBytes(data));
  }
  return initData;
}

/**
 * Extract only the fields present in a raw track entry — no defaults.
 * Clone operations layer this partial over the parent so inherited values
 * survive (§5.1.6: a clone inherits all attributes except Track Name).
 */
function parseCatalogTrackFields(
  raw: Record<string, unknown>,
  initDataList: Map<string, Uint8Array>
): Partial<MoqCatalogTrack> {
  const number = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  const initRef = isString(raw.initRef) ? raw.initRef : undefined;

  const fields: Partial<MoqCatalogTrack> = {};
  if (isString(raw.name)) fields.name = raw.name;
  if (isString(raw.namespace)) fields.namespace = parseNamespaceString(raw.namespace);
  if (isString(raw.packaging)) fields.packaging = raw.packaging;
  if (typeof raw.isLive === 'boolean') fields.isLive = raw.isLive;
  if (isString(raw.role)) fields.role = raw.role;
  if (isString(raw.label)) fields.label = raw.label;
  if (isString(raw.lang)) fields.language = raw.lang;
  if (isString(raw.codec)) fields.codec = raw.codec;
  if (isString(raw.mimeType)) fields.mimeType = raw.mimeType;
  if (isString(raw.channelConfig)) fields.channelConfig = raw.channelConfig;
  fields.bitrate = number(raw.bitrate);
  fields.avgBitrate = number(raw.avgBitrate);
  fields.width = number(raw.width);
  fields.height = number(raw.height);
  fields.framerate = number(raw.framerate);
  fields.timescale = number(raw.timescale);
  fields.samplerate = number(raw.samplerate);
  fields.renderGroup = number(raw.renderGroup);
  fields.altGroup = number(raw.altGroup);
  fields.targetLatency = number(raw.targetLatency);
  fields.jitter = number(raw.jitter);
  fields.maxGopDuration = number(raw.maxGopDuration);
  fields.maxGroupDuration = number(raw.maxGroupDuration);
  fields.temporalId = number(raw.temporalId);
  fields.spatialId = number(raw.spatialId);
  if (isPlainObject(raw.buffers)) {
    fields.buffers = {
      target: number(raw.buffers.target),
      min: number(raw.buffers.min),
      max: number(raw.buffers.max),
    };
  }
  if (Array.isArray(raw.depends)) fields.dependencies = raw.depends.filter(isString);
  if (initRef) fields.initData = initDataList.get(initRef);
  if (isPlainObject(raw.authInfo)) fields.authInfo = raw.authInfo;
  return fields;
}

function parseCatalogTrack(
  raw: Record<string, unknown>,
  fallbackNamespace: string[],
  initDataList: Map<string, Uint8Array>
): MoqCatalogTrack | null {
  const name = raw.name;
  if (!isString(name)) return null;
  return {
    namespace: fallbackNamespace,
    packaging: '',
    isLive: false,
    ...parseCatalogTrackFields(raw, initDataList),
    name,
  };
}

// ============================================================================
// Catalog updates (independent + delta)
// ============================================================================

// §5.1.1: a subscriber MUST NOT parse a catalog version it does not
// understand; versions follow the 'draft-XX' convention. The bare '1' is a
// lenient interop alias seen in early catalogs. (Interop check pending —
// verify which form publishers actually emit.)
const SUPPORTED_MSF_VERSIONS = new Set(['draft-01', '1']);

export interface MoqCatalogUpdateOptions {
  /** Namespace of the catalog track itself — inherited by tracks that omit one (§5.2.2). */
  catalogNamespace: string[];
  /** Fragment parameters for variable substitution (§5.4). */
  variables?: Record<string, string>;
}

/**
 * Apply one catalog object to the current catalog state. An independent
 * catalog (no `deltaUpdate`) replaces the state; a delta update requires
 * a current catalog and applies its `add`/`remove`/`clone`/`update`
 * operations in order (§5.1.6). Returns the new catalog.
 */
export function applyMoqCatalogUpdate(
  current: MoqCatalog | undefined,
  text: string,
  options: MoqCatalogUpdateOptions
): MoqCatalog {
  const substituted = substituteVariables(JSON.parse(text), options.variables ?? {});
  if (!isPlainObject(substituted)) throw new Error('MSF catalog is not a JSON object');
  const raw = substituted as RawCatalog;

  if (raw.deltaUpdate !== undefined) {
    if (!current) throw new Error('MSF delta update received with no prior catalog');
    if (!Array.isArray(raw.deltaUpdate)) throw new Error('MSF deltaUpdate is not an array');
    const initDataList = new Map([...(current.initDataList ?? []), ...parseInitDataList(raw.initDataList)]);
    return applyDelta(current, raw.deltaUpdate, options, initDataList);
  }

  if (!isString(raw.version)) throw new Error('MSF catalog is missing its version');
  if (!SUPPORTED_MSF_VERSIONS.has(raw.version)) {
    throw new Error(`unsupported MSF catalog version ${raw.version}`);
  }
  if (!Array.isArray(raw.tracks)) throw new Error('MSF catalog is missing its tracks array');

  const initDataList = parseInitDataList(raw.initDataList);
  const tracks = raw.tracks
    .filter(isPlainObject)
    .map((entry) => parseCatalogTrack(entry, options.catalogNamespace, initDataList))
    .filter((track): track is MoqCatalogTrack => track !== null);

  const catalog: MoqCatalog = { version: raw.version, tracks, initDataList };
  if (typeof raw.generatedAt === 'number') catalog.generatedAt = raw.generatedAt;
  if (raw.isComplete === true) catalog.isComplete = true;
  return catalog;
}

function applyDelta(
  current: MoqCatalog,
  operations: unknown[],
  options: MoqCatalogUpdateOptions,
  initDataList: Map<string, Uint8Array>
): MoqCatalog {
  let tracks = [...current.tracks];
  const keyOf = (namespace: readonly string[], name: string) => moqTrackId(namespace, name);

  for (const operation of operations) {
    if (!isPlainObject(operation) || !isString(operation.op) || !Array.isArray(operation.tracks)) {
      throw new Error('malformed MSF delta operation');
    }
    const entries = operation.tracks.filter(isPlainObject);
    switch (operation.op) {
      case 'add': {
        for (const entry of entries) {
          const track = parseCatalogTrack(entry, options.catalogNamespace, initDataList);
          if (track) tracks.push(track);
        }
        break;
      }
      case 'remove': {
        const removed = new Set(
          entries
            .filter((entry) => isString(entry.name))
            .map((entry) =>
              keyOf(
                isString(entry.namespace) ? parseNamespaceString(entry.namespace) : options.catalogNamespace,
                entry.name as string
              )
            )
        );
        tracks = tracks.filter((track) => !removed.has(keyOf(track.namespace, track.name)));
        break;
      }
      case 'clone': {
        for (const entry of entries) {
          if (!isString(entry.parentName)) throw new Error('MSF clone operation is missing parentName');
          const parentNamespace = isString(entry.parentNamespace)
            ? parseNamespaceString(entry.parentNamespace)
            : options.catalogNamespace;
          const parent = tracks.find(
            (track) => keyOf(track.namespace, track.name) === keyOf(parentNamespace, entry.parentName as string)
          );
          if (!parent) throw new Error(`MSF clone operation references unknown parent ${entry.parentName}`);
          const overrides = parseCatalogTrackFields(entry, initDataList);
          if (!isString(overrides.name) || overrides.name === parent.name) {
            throw new Error('MSF clone operation requires a new track name');
          }
          tracks.push({ ...parent, ...pruneUndefined(overrides) });
        }
        break;
      }
      case 'update': {
        for (const entry of entries) {
          // §5.1.6 requires parentName on an update track object, but the
          // §5.6.4 example identifies its target with `name` — the two
          // readings of the same draft disagree. Both are accepted: under
          // the strict one, a publisher following the spec's own example
          // takes down the catalog subscription.
          const targetName = isString(entry.parentName) ? entry.parentName : entry.name;
          // Names both, because both are accepted: an error that says
          // `parentName` sends a publisher following §5.6.4's example
          // looking for a field this reader does not require.
          if (!isString(targetName)) {
            throw new Error('MSF update operation is missing parentName (or name) to identify its target');
          }
          const scope = isString(entry.parentName) ? entry.parentNamespace : entry.namespace;
          const targetNamespace = isString(scope) ? parseNamespaceString(scope) : options.catalogNamespace;
          const index = tracks.findIndex(
            (track) => keyOf(track.namespace, track.name) === keyOf(targetNamespace, targetName)
          );
          // msf-01 does not say what to do when the target is absent.
          // Treated as an error, matching clone's unknown-parent handling
          // and §5.3's "evaluation continues until all operations are
          // successfully applied".
          if (index === -1) throw new Error(`MSF update operation references unknown track ${targetName}`);
          // Declared attributes override, absent ones survive (§5.1.6), and
          // the track holds its position so a later operation sees the list
          // the publisher built.
          tracks[index] = { ...tracks[index]!, ...pruneUndefined(parseCatalogTrackFields(entry, initDataList)) };
        }
        break;
      }
      default:
        throw new Error(`unknown MSF delta operation ${operation.op}`);
    }
  }
  return { ...current, tracks, initDataList };
}

function pruneUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

// ============================================================================
// Catalog → Presentation
// ============================================================================

const TEXT_ROLES = new Set(['caption', 'subtitle']);
const AUDIO_ROLES = new Set(['audio', 'audiodescription']);
const VIDEO_ROLES = new Set(['video', 'signlanguage']);

type MediaKind = 'video' | 'audio' | 'text';

function mediaKindOf(track: MoqCatalogTrack): MediaKind | null {
  // Only LOC-packaged tracks are directly renderable media; timeline,
  // event, log, and metrics tracks are engine plumbing.
  if (track.packaging !== 'loc') return null;
  if (track.role !== undefined) {
    if (VIDEO_ROLES.has(track.role)) return 'video';
    if (AUDIO_ROLES.has(track.role)) return 'audio';
    if (TEXT_ROLES.has(track.role)) return 'text';
    return null;
  }
  // Role is optional — fall back to intrinsic fields.
  if (track.width !== undefined || track.height !== undefined || track.framerate !== undefined) return 'video';
  if (track.samplerate !== undefined || track.channelConfig !== undefined) return 'audio';
  return null;
}

function moqFieldsOf(track: MoqCatalogTrack): MoqTrackFields {
  const fields: MoqTrackFields = {
    namespace: track.namespace,
    name: track.name,
    packaging: track.packaging,
    isLive: track.isLive,
  };
  if (track.timescale !== undefined) fields.timescale = track.timescale;
  if (track.framerate !== undefined) fields.framerate = track.framerate;
  if (track.renderGroup !== undefined) fields.renderGroup = track.renderGroup;
  if (track.altGroup !== undefined) fields.altGroup = track.altGroup;
  if (track.targetLatency !== undefined) fields.targetLatency = track.targetLatency;
  if (track.jitter !== undefined) fields.jitter = track.jitter;
  if (track.buffers !== undefined) fields.buffers = track.buffers;
  if (track.maxGopDuration !== undefined) fields.maxGopDuration = track.maxGopDuration;
  if (track.maxGroupDuration !== undefined) fields.maxGroupDuration = track.maxGroupDuration;
  if (track.dependencies !== undefined) fields.dependencies = track.dependencies;
  if (track.initData !== undefined) fields.initData = track.initData;
  if (track.authInfo !== undefined) fields.authInfo = track.authInfo;
  if (track.samplerate !== undefined) fields.samplerate = track.samplerate;
  if (track.channelConfig !== undefined) fields.channelConfig = track.channelConfig;
  return fields;
}

function trackUrl(sessionUri: string, track: MoqCatalogTrack): string {
  return `${sessionUri}#msf:${encodeNamespaceName(track.namespace, track.name)}`;
}

/** Sane upper bound on a decoded channel count (WebCodecs practical ceiling). */
const MAX_CHANNELS = 255;

/**
 * Channel count from a catalog `channelConfig` (§5.2.21), or `undefined` if
 * it doesn't resolve to one. Accepts a plain count (`'2'`) and the dotted
 * surround form (`'5.1'` → 6, `'7.1.4'` → 12); `parseInt` alone would read
 * `'5.1'` as 5 and silently drop the LFE channel.
 *
 * `channelConfig` is intentionally flexible (codec-specific layout strings
 * are allowed alongside numeric ones), so anything this parser doesn't
 * recognize — and any numeric total that isn't a sane positive channel
 * count, guarding against overflowed or hostile input producing `Infinity`
 * — returns `undefined` rather than guessing stereo. Callers decide how to
 * substitute (see `moqCatalogToPresentation` and `toAudioDecoderConfig`).
 */
export function parseChannelConfig(channelConfig: string | undefined): number | undefined {
  if (!channelConfig) return undefined;
  const trimmed = channelConfig.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return undefined;
  const total = trimmed.split('.').reduce((sum, part) => sum + Number(part), 0);
  return Number.isSafeInteger(total) && total > 0 && total <= MAX_CHANNELS ? total : undefined;
}

/**
 * Project the current catalog onto the shared media model. The result is
 * a fully resolved `Presentation` whose tracks are `LiveOf` shapes
 * (`deliveryMode: 'push'`) — selection consumes them as-is; nothing else
 * ever needs "resolving" for a push source.
 */
export function moqCatalogToPresentation(
  catalog: MoqCatalog,
  presentation: MaybeResolvedPresentation,
  sessionUri: string
): Presentation {
  const video: MoqVideoTrack[] = [];
  const audio: MoqAudioTrack[] = [];
  const text: MoqTextTrack[] = [];

  for (const track of catalog.tracks) {
    const kind = mediaKindOf(track);
    if (!kind) continue;
    const id = moqTrackId(track.namespace, track.name);
    const shared = {
      id,
      url: trackUrl(sessionUri, track),
      bandwidth: track.bitrate ?? track.avgBitrate ?? 0,
      language: track.language,
      deliveryMode: 'push' as const,
      moq: moqFieldsOf(track),
    };

    if (kind === 'video') {
      video.push({
        ...shared,
        type: 'video',
        mimeType: track.mimeType ?? 'video/loc',
        codecs: track.codec ? [track.codec] : [],
        width: track.width,
        height: track.height,
        frameRate: track.framerate !== undefined ? { frameRateNumerator: track.framerate } : undefined,
      });
    } else if (kind === 'audio') {
      audio.push({
        ...shared,
        type: 'audio',
        mimeType: track.mimeType ?? 'audio/loc',
        codecs: track.codec ? [track.codec] : [],
        groupId: track.altGroup !== undefined ? `alt-${track.altGroup}` : 'audio',
        name: track.label ?? track.name,
        // `AudioTrack` requires both, so an absent catalog value has to
        // become a conventional one here. That substitution is invisible
        // downstream, which is why `moq.samplerate`/`moq.channelConfig`
        // carry the raw values — `toAudioDecoderConfig` reads those rather
        // than trusting these for decoder configuration.
        sampleRate: track.samplerate ?? 48_000,
        channels: parseChannelConfig(track.channelConfig) ?? 2,
      });
    } else {
      text.push({
        ...shared,
        type: 'text',
        mimeType: track.mimeType ?? 'text/vtt',
        groupId: track.altGroup !== undefined ? `alt-${track.altGroup}` : 'text',
        label: track.label ?? track.name,
        kind: track.role === 'caption' ? 'captions' : 'subtitles',
      });
    }
  }

  const selectionSets: SelectionSet[] = [];
  if (video.length) {
    const set: VideoSelectionSet = {
      id: 'moq-video',
      type: 'video',
      switchingSets: [{ id: 'moq-video-main', type: 'video', tracks: video }],
    };
    selectionSets.push(set);
  }
  if (audio.length) {
    const set: AudioSelectionSet = {
      id: 'moq-audio',
      type: 'audio',
      switchingSets: [{ id: 'moq-audio-main', type: 'audio', tracks: audio }],
    };
    selectionSets.push(set);
  }
  if (text.length) {
    const set: TextSelectionSet = {
      id: 'moq-text',
      type: 'text',
      switchingSets: [{ id: 'moq-text-main', type: 'text', tracks: text }],
    };
    selectionSets.push(set);
  }

  return {
    id: `moq:${sessionUri}`,
    url: presentation.url,
    startTime: 0,
    selectionSets,
  };
}

/**
 * One-shot parse of an independent catalog object into a `Presentation`
 * — the `config.parseCatalog` default, mirroring `ParsePresentation`'s
 * shape. Live delta updates go through `applyMoqCatalogUpdate` +
 * `moqCatalogToPresentation` with retained catalog state.
 */
export function parseMoqCatalog(text: string, presentation: MaybeResolvedPresentation): Presentation {
  const source = parseMoqSource(presentation.url);
  const catalog = applyMoqCatalogUpdate(undefined, text, {
    catalogNamespace: source.namespace,
    variables: source.fragmentParams,
  });
  return moqCatalogToPresentation(catalog, presentation, source.sessionUri);
}
