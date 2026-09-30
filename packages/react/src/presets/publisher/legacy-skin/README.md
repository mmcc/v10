# Legacy publisher skin

Pre-VJSC skin sources for the publisher, vendored from the `@videojs/skins` legacy tree that upstream removed in #2550. The `default/` and `shared/` subtrees keep their original layout so relative imports resolve unchanged. `packages/html` and `packages/react` each hold an identical copy under `src/presets/publisher/legacy-skin/` (HTML adds `host.css` for its shadow root) — change both together.

Delete both copies once the publisher skin is ported to VJSC under `packages/skins/src/skins/`.
