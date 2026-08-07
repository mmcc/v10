---
status: implemented
date: 2026-07-31
definition: sketched
---

# MoQ live publish

Engine composition for **browser live ingest to a MoQ relay**: an
interactive-live product captures camera / microphone / screen in the
page, encodes with WebCodecs, and publishes LOC-packaged tracks plus an
MSF catalog over moq-transport draft-19 — pairing with the existing MoQ
playback engine so Video.js supplies both halves of a sub-second
glass-to-glass loop.

**Composition mechanism: additive, as a new composition family.** Unlike
the playback use cases, this variant is not assembled by subtracting or
tuning `createSimpleHlsEngine` — there is no shared baseline to vary. The
delivery scenario earns an entirely new composed engine
(`createMoqPublishEngine` in `packages/spf/src/publish/`), the first
composition family outside `playback/`. The
[README's](./README.md#decomposition-rubric) rubric still fires on all
four criteria: composition-time assembly (a new behavior list, not
runtime config on always-on behaviors), a recognizable delivery scenario,
a constituent feature ([moq-publish](../features/moq-publish.md)), and a
customer story (below).

## Status

Implemented as the v1 vertical slice behind
[rfc/moq-publisher.md](../../../../rfc/moq-publisher.md) (status `draft`,
decision pending review). Chromium-only (`MediaStreamTrackProcessor`,
`WebTransport`). Verified end-to-end by the in-page loopback demo and the
full-pipeline session-pair test (see
[moq-publish § Verification](../features/moq-publish.md#verification)).

## Target delivery context

Interactive-live products — creator streaming, auctions, watch parties —
that publish from the browser and want sub-second latency to viewers.
The publisher pairs with the MoQ player (`<simple-moq-video>` /
`playback/engines/moq/`) so one stack covers ingest and playback; the
sandbox's loopback template demonstrates exactly that pairing in a single
page (camera in, playback out).

## Phases of complexity

Default three-phase framing per
[README § The three default complexity phases](./README.md#the-three-default-complexity-phases).

| Phase | What | Status |
|---|---|---|
| **1 — Basic functionality** | Capture → encode → publish end-to-end: camera or screen source, single H.264/VP8 rendition + Opus, MSF catalog track, GoP = MoQ group, announce-and-serve flow against a relay (solicited NAMESPACE announce, relay-pulled per-track SUBSCRIBEs) | **Implemented** |
| **2 — Features relevant to the use case** | Device enumeration + selection, screen share with microphone merge, camera/mic mute toggles (capture keeps running), local preview, publish stats (~1 Hz), error surfacing per pipeline stage, orderly shutdown (inbound GOAWAY → draining; clean per-subscription FINs + NAMESPACE_DONE retraction) | **Implemented** |
| **3 — Optimizations** | Simulcast (per-rendition encoder + publisher pairs), automatic reconnect, datagram delivery for loss-tolerant traffic, congestion-aware encode tuning, demand-aware encoding (the transport is already demand-gated per subscription; the encoders still run unwatched) | Not implemented — tracked as [moq-publish](../features/moq-publish.md)'s extension boundary |

## Composition specifics

All four mechanism buckets considered; this variant is the degenerate
all-additive case.

### Subtracted

None — empty bucket by construction. There is no default composition in
the publish direction to subtract from.

### Added

The entire behavior list of
[`createMoqPublishEngine`](../../../../packages/spf/src/publish/engines/moq/engine.ts):
`enumerateCaptureDevices`, `acquireCaptureSource`, `syncPreview`,
`applyTrackToggles`, `probeEncoderSupport`, `setupEncoderActors`,
`pumpMediaFrames`, `trackPublishStats`, `openPublishSession`,
`setupTrackPublishers`, `deriveCatalog`, then `shareSignals`. All belong
to the constituent feature — this use case adds no use-case-specific glue
behaviors of its own (nothing to hold out of the feature registry).

### Alternative implementations

None composed; the engine exposes seams instead of swap-in behaviors:
`connectTransport` (WebTransport default — the loopback relay and tests
inject in-memory transports), `buildCatalog` (MSF default), `chunkSink`
(route-to-track-publishers default; observe or replace transport),
`selectEncoderConfig` (first-supported default).

### Alternative default configurations

Engine config tuning: `groupDurationSec`, `video` / `audio` rendition
tuning, `maxEncodeQueueSize`, `maxQueuedGroups`, `statsIntervalMs` — see
[moq-publish § Config surface](../features/moq-publish.md#config-surface).
The adapter forwards `engineConfig` through unchanged.

## Constituent features

- **[moq-publish](../features/moq-publish.md)** — used as-is; the use
  case composes the feature's full capability (capture → encode → MOQT
  publish). Per [README § Cross-link discipline](./README.md#cross-link-discipline),
  this is the "feature built exclusively for one use case" shape: the
  feature doc captures the engine capability, this doc captures the
  delivery scenario and its consumer surface.
- **`[moq-playback]`** *(candidate — no feature doc yet)* — the paired
  subscribe side. Not composed into the publisher engine (so not a
  constituent in the compositional sense), but the customer story is the
  pairing: publisher + relay + MoQ player closing the interactive-live
  loop.

## Customer-policy surface

Above the engine, the publisher rides the standard player architecture:

- **Media host** — `MoqPublishMedia`
  ([`packages/media/src/dom/moq-publish/`](../../../../packages/media/src/dom/moq-publish/media.ts)):
  `publishEndpoint`, `publishNamespace`, `captureSource`
  (`'camera' | 'screen' | null`), `videoInputDeviceId` /
  `audioInputDeviceId`, `cameraMuted` / `micMuted`,
  `publish()` / `unpublish()` (promise settles on live / error /
  cancel), `publishState`, `publishStats`, `publishError`, plus the
  attached `<video>` as local preview. Capability-gated via the
  `MediaPublish*` / `MediaCapture*` contracts and `isMedia*Capable`
  predicates in `@videojs/media` core.
- **Player preset** — `publisherFeatures` (`@videojs/core`): publish,
  capture-devices, capture-source, capture-tracks, and publish-stats
  feature slices plus controls / fullscreen / error.
- **Elements + skin** — `<video-publisher>` provider and
  `<publisher-skin>` with the publisher control set (publish button,
  camera/mic mutes and device menus, screen share, badge / timer /
  connection indicator, capture placeholder) in `@videojs/html`;
  publisher skin CSS in `@videojs/skins` reusing the shared theme tokens.
- **Direct media element** — `<moq-publish-video>` for skin-less
  embedding (the sandbox's `?real` mode).

## Variant-decision signal source

**Adapter-upfront only.** Constructing the publisher host
(`MoqPublishMedia` / `<video-publisher>`) *is* the variant decision. The
detect-from-parser path other use cases enumerate does not exist in this
direction — there is no source to detect from; capture intent is supplied
by the consumer.

## Open questions

- **Phase 3 items' composition shape** — simulcast and reconnect are
  scoped as the constituent feature's extension boundary; whether either
  warrants use-case-level composition choices (e.g. a
  conference-publisher variant with different drop policies) is open
  until a second publish-direction scenario materializes.
- **Relay interop beyond loopback** — the catalog namespace encoding is
  interop-pending (see
  [moq-publish § Open questions](../features/moq-publish.md#open-questions));
  the sandbox's `?real` mode against public relays is the proving ground.

## Related use cases

None yet — this is the first publish-direction use case. Playback
compositions ([`audio-only-mode-override`](./audio-only-mode-override.md),
[`video-only-mode-override`](./video-only-mode-override.md),
[`background-video`](./background-video.md)) share no baseline with it.

## See also

- [`../features/moq-publish.md`](../features/moq-publish.md) —
  constituent feature (capability, signals, config, verification).
- [`../features/clusters.md` § Publish](../features/clusters.md#publish)
  — cluster heuristics for the publish direction.
- [rfc/moq-publisher.md](../../../../rfc/moq-publisher.md) — proposal and
  option analysis this slice implements.
- [`README.md`](./README.md) — use-case-composition doc-type spec.
- [`apps/sandbox/templates/moq-publisher/`](../../../../apps/sandbox/templates/moq-publisher/main.ts)
  — loopback / real-relay / synthetic-capture demo modes ·
  [`publish-transport.test.ts`](../../../../packages/spf/src/publish/engines/moq/tests/publish-transport.test.ts)
  — full-pipeline session-pair proof.
