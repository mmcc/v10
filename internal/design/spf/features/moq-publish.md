---
status: implemented
date: 2026-07-31
definition: sketched
---

# MoQ publish

The engine's **publish direction**: camera / microphone / screen capture →
WebCodecs encode → Media over QUIC (MOQT) publish to a relay. Implemented
as its own composed engine, `createMoqPublishEngine`, in a new
`publish/` SPF layer (peer of `playback/`), publishing one LOC-packaged
video rendition plus one Opus audio track plus an MSF catalog track over
moq-transport draft-19 — the same dialect, wire layer, and media modules
the MoQ playback engine consumes from the other side.

**Classification note.** The
[Media-src / Player / Borderline axis](./clusters.md#media-src-vs-player-vs-borderline)
presumes the playback direction ("required to support a media-src
permutation") and does not transfer cleanly: publish is a new engine
*direction*, not a source permutation or an additive player feature.
Functionally it plays the Media-src-foundation role for that direction —
without it, publishing doesn't exist at all. It anchors the new
[Publish cluster](./clusters.md#publish).

## Status

- **Composition:** implemented — `createMoqPublishEngine`
  ([`publish/engines/moq/engine.ts`](../../../../packages/spf/src/publish/engines/moq/engine.ts))
  composes `enumerateCaptureDevices`, `acquireCaptureSource`,
  `syncPreview`, `applyTrackToggles` (capture), `probeEncoderSupport`,
  `setupEncoderActors`, `pumpMediaFrames`, `trackPublishStats` (encode),
  `openPublishSession`, `setupTrackPublishers`, `deriveCatalog`
  (transport), with `shareSignals` last. Exported as
  `@videojs/spf/moq-publish`.
- **Definition depth:** sketched — implemented and code-grounded. The
  vertical slice sits behind [rfc/moq-publisher.md](../../../../rfc/moq-publisher.md)
  (status `draft`, decision pending review).
- **Platform:** Chromium-only v1 — `MediaStreamTrackProcessor` and
  `WebTransport` are hard dependencies (see Verification for how tests
  and the sandbox cope).

## Phases of complexity

Scope slices along the pipeline. All four compose into the one v1 engine;
none is separately composable today.

| Phase | What | Status |
|---|---|---|
| Capture | Device enumeration (`devicechange`-reactive, label refresh on grant); capture-source acquisition (`getUserMedia` camera, `getDisplayMedia` + microphone-merge screen share, re-acquire on selection-identity change, stale-async guards); preview mirroring via `srcObject` (forced muted + playsInline); mute toggles via `track.enabled` (capture keeps running) | **Implemented** |
| Encode | `isConfigSupported` probing over a candidate ladder (default `avc1.42E01F` in `avc` bitstream format with a `vp8` fallback; Opus with a 48 kHz fallback; `config.video.codec` prepends rather than replaces); `selectEncoderConfig` strategy resolves support → active encodings; per-kind WebCodecs encoder actors; frame pumping with a timestamp-driven forced-keyframe cadence so **GoP = MoQ group** (`groupDurationSec`, default 2 s); LOC packaging of every chunk (Timestamp / Timescale / Config-on-keyframes) | **Implemented** |
| Transport | Publish session speaking draft-19: SETUP exchange, **advisory** PUBLISH_NAMESPACE (rejection surfaced, never fatal), publisher-initiated PUBLISH per track (catalog / video / audio), inbound SUBSCRIBEs answered with SUBSCRIBE_OK, REQUEST_UPDATE routing, GOAWAY → `draining`, PUBLISH_DONE per track on stop; one `TrackPublisherActor` per track writing subgroup streams (video: new group per keyframe; audio + catalog: group-per-frame — every object a random-access point); MSF catalog derivation re-sent on any input-identity change | **Implemented** |
| Observability | ~1 Hz `publishStats` sampling from the encoder actor counters (`encodedFps`, bitrates, `droppedFrames`, `bytesSent`) | **Implemented** — `droppedGroups` is counted on the track publishers but not yet folded into `publishStats`; `subscriberCount` is tracked on the session actor but surfaces as `NaN` |

**Backpressure is two-staged by design.** The encoder actor drops *delta*
frames when the codec's `encodeQueueSize` exceeds `maxEncodeQueueSize`
(forced keyframes are never dropped, so every group still starts
decodable); the track publisher aborts whole *stale groups* when more
than `maxQueuedGroups` are queued behind transport backpressure at a
group boundary, resuming cleanly at the boundary keyframe.

## Signals inventory

State slots (consumer-intent slots are materialized by `shareSignals`
and written by the adapter; fact slots are behavior-owned):

| Slot | Kind | Writer(s) |
|---|---|---|
| `endpoint`, `publishActivated`, `captureSource`, `cameraMuted`, `micMuted` | intent | adapter (via `onSignalsReady` refs) |
| `captureDevices` | fact | `enumerateCaptureDevices` (sole) |
| `captureStatus`, `captureTracks` | fact | `acquireCaptureSource` (sole) |
| `encoderSupport`, `activeEncodings` | fact | `probeEncoderSupport` (sole) |
| `sessionStatus` | fact | `openPublishSession` (sole) |
| `publishStats` | fact | `trackPublishStats` (sole) |
| `publishError` | fact | multi-writer, partitioned by error domain via the `code` field: `acquireCaptureSource` (`capture`), `probeEncoderSupport` / `setupEncoderActors` / `pumpMediaFrames` (`encode`), `setupTrackPublishers` (`transport`), `openPublishSession` (`transport` / `protocol`) |

Context slots (platform objects and owned resources):

| Slot | Owner |
|---|---|
| `previewElement` | adapter (intent, via `shareSignals`) |
| `captureStream` | `acquireCaptureSource` |
| `videoEncoderActor`, `audioEncoderActor` | `setupEncoderActors` |
| `publishSessionActor` | `openPublishSession` |
| `catalogTrackPublisher`, `videoTrackPublisher`, `audioTrackPublisher` | `setupTrackPublishers` |

The `publishError` multi-writer slot is deliberate: writers occupy
disjoint decision domains (their own pipeline stage), each write is a
one-shot failure fact, and `openPublishSession` clears only its own
domains (`transport` / `protocol`) on a fresh attempt — no writer touches
another's failures.

## Implementation surface

Behaviors (`packages/spf/src/publish/behaviors/`; DOM-bound ones under
`dom/`):

| Behavior | File | Role |
|---|---|---|
| `enumerateCaptureDevices` | `dom/enumerate-capture-devices.ts` | Sync `captureDevices` with platform inputs; re-enumerate on `devicechange` and on capture grant |
| `acquireCaptureSource` | `dom/acquire-capture-source.ts` | Own the capture stream for the selection; drive `captureStatus`; snapshot `captureTracks` |
| `syncPreview` | `dom/sync-preview.ts` | Mirror the capture stream into the preview element |
| `applyTrackToggles` | `dom/apply-track-toggles.ts` | Sync mute intents onto `track.enabled` |
| `probeEncoderSupport` | `dom/probe-encoder-support.ts` | Probe WebCodecs support; resolve `activeEncodings` through `selectEncoderConfig` |
| `setupEncoderActors` | `dom/setup-encoder-actors.ts` | Own the encoder actor pair (cluster owner; reverse-order teardown) |
| `pumpMediaFrames` | `dom/pump-media-frames.ts` | `MediaStreamTrackProcessor` read loops → `encode` messages; keyframe cadence |
| `trackPublishStats` | `track-publish-stats.ts` | Sample encoder counters into `publishStats` (DOM-free via a structural actor view) |
| `openPublishSession` | `open-publish-session.ts` | Own the publish session actor; gate on `endpoint` + `publishActivated` + capture `'active'`; mirror lifecycle into `sessionStatus` |
| `setupTrackPublishers` | `setup-track-publishers.ts` | PUBLISH each track; own the per-track publisher actors; PUBLISH_DONE on teardown |
| `deriveCatalog` | `derive-catalog.ts` | Build + send the MSF catalog as object 0 of a fresh group on every input change |

Actors and session:

| Unit | File | Role |
|---|---|---|
| Encoder actor core + video/audio specializations | `publish/actors/dom/{encoder-actor,video-encoder,audio-encoder}.ts` | Own one WebCodecs encoder; delta-drop backpressure; LOC-package output to the `chunkSink`; counter snapshots |
| `TrackPublisherActor` | `publish/actors/track-publisher.ts` | One MOQT track → subgroup streams (one uni stream per group); group-per-keyframe or group-per-frame; stale-group drop policy |
| Publish session driver + actor | `publish/session/publish-session.ts` | Draft-19 publish-side protocol driver (callback-shaped, no signals) + the reactive session actor behaviors consume |
| Media-host adapter | `publish/engines/moq/adapter.ts` | `MoqPublishMediaMixin` — expresses the `@videojs/media` publisher capabilities structurally; owns contract events |

Shared modules (consumed, not owned — encode-direction complements of the
playback stack's decode direction):

- [`network/moqt/subgroup-writer.ts`](../../../../packages/spf/src/network/moqt/subgroup-writer.ts)
  — subgroup data-stream writing; round-trips through `object-stream.ts`'s
  reader. The only new `network/moqt` file: the parent-owned wire layer
  needed **no new control-message codecs** (its codec was already
  symmetric), so publish additions there stayed additive siblings.
- [`media/moq/loc-packaging.ts`](../../../../packages/spf/src/media/moq/loc-packaging.ts)
  / [`media/moq/build-catalog.ts`](../../../../packages/spf/src/media/moq/build-catalog.ts)
  — encode complements of `loc.ts` / `parse-catalog.ts`; each round-trips
  through its decode counterpart as the module's acceptance test.

## Config surface

All on `MoqPublishEngineConfig`:

| Config | Default | Role |
|---|---|---|
| `groupDurationSec` | 2 | Forced-keyframe cadence; each GoP becomes one MoQ group |
| `video` / `audio` | track-derived, 2.5 Mbps / 128 kbps | Single-rendition tuning (an array is the simulcast seam, later) |
| `selectEncoderConfig` | first supported per kind | Strategy resolving probed support → active encodings |
| `chunkSink` | route to matching track publisher | Packaged-chunk destination; override to observe or replace transport (LOC packaging itself is actor-internal via `packageLocFrame`) |
| `maxEncodeQueueSize` | 60 | Encoder queue depth above which delta frames drop |
| `statsIntervalMs` | 1000 | `publishStats` sampling period |
| `maxQueuedGroups` | 3 | Groups the transport may fall behind before the stale-group drop |
| `connectTransport` | real `WebTransport` | Transport seam (tests / loopback relay / alternative hosts) |
| `buildCatalog` | `buildMsfCatalog` | MSF catalog-JSON builder seam |
| `requestTimeoutMs` | 10000 | Control-request response bound for the publish session |

## What's not implemented

**Extension boundary (in-feature growth):**

- **Simulcast** — single video rendition today; `config.video` as an
  array plus per-rendition encoder + publisher actor pairs is the
  designed-in additive path.
- **Reconnect / retry** — a failed or closed session stays failed;
  `publish()` may be retried by the consumer but nothing resumes
  automatically.
- **Datagram object delivery** — subgroup streams only.
- **Catalog deltas** — every catalog send is a full independent catalog.
- **`droppedGroups` / `subscriberCount` in `publishStats`** — counted on
  the track publishers / session actor respectively, not yet sampled in.
- **Subscriber-aware publishing** — encoding runs regardless of demand
  (the playback engine's suspend-on-pause has no publish-side analog yet).

**Constraints (v1, by design):**

- **Chromium-only** (`MediaStreamTrackProcessor`, `WebTransport`).
- **Live-edge only** — the session serves no history: FETCH and other
  non-SUBSCRIBE inbound requests are answered with REQUEST_ERROR
  (publish-only endpoint), and subscribers receive objects from their
  subscribe point forward.
- **Single video rendition + single Opus audio track + one catalog track.**

**Out of scope (different architectural layer):**

- The media host (`MoqPublishMedia` in
  [`packages/media/src/dom/moq-publish/`](../../../../packages/media/src/dom/moq-publish/media.ts))
  and the `MediaPublish*` / `MediaCapture*` capability contracts +
  `isMedia*Capable` predicates in `@videojs/media` core.
- The player surface: the `publisherFeatures` preset (`@videojs/core`),
  the publisher UI cores/elements, `<video-publisher>` /
  `<publisher-skin>` / `<moq-publish-video>` (`@videojs/html`), and the
  publisher skin CSS (`@videojs/skins`).
- The engine adapter (`MoqPublishMediaMixin`) is the seam between the two
  layers — part of this feature's surface, consumed from above.

## Verification

- **Unit** — one colocated test file per behavior, actor, and the session
  driver (`publish/behaviors/dom/tests/`, `publish/behaviors/tests/`,
  `publish/actors/dom/tests/`, `publish/actors/tests/`,
  `publish/session/tests/`), plus engine composition and adapter tests
  (`publish/engines/moq/tests/{engine,adapter}.test.ts`).
- **Round-trips against the decode direction** —
  `network/moqt/tests/publish-direction.test.ts` pins the publish-side
  encode↔decode pairs against the existing decoders as golden reference
  (and documents that no new codecs were needed);
  `network/moqt/tests/subgroup-writer.test.ts` round-trips written
  subgroups through the object-stream reader;
  `media/moq/tests/loc-packaging.test.ts` round-trips through
  `toLocFrame`; `media/moq/tests/build-catalog.test.ts` round-trips
  through `parseMoqCatalog` → presentation → decoder configs.
- **Full pipeline** —
  `publish/engines/moq/tests/publish-transport.test.ts`: real capture
  (canvas + oscillator) → real WebCodecs encode → the publish session
  over an in-memory transport pair → the **existing subscribe driver**
  on the far side.
- **Live smoke** — the sandbox
  [`moq-publisher` template](../../../../apps/sandbox/templates/moq-publisher/main.ts):
  the default mode is an end-to-end in-page loopback — the real publish
  engine publishes into an in-memory MOQT relay and a bare
  `<simple-moq-video>` beside it subscribes and renders the camera back;
  `?real` publishes to an actual relay, `?synthetic` stubs capture for
  headless runs.

## Open questions

- **Catalog namespace encoding is interop-pending** — `build-catalog.ts`
  emits the path-joined string form `parse-catalog.ts` assumes, keeping
  the pair self-consistent whatever the drafts settle on. Tracked in the
  module docs; revisit on relay interop beyond the loopback.
- **Simulcast composition shape** — per-rendition actor pairs are the
  lean; whether selection/ladder logic becomes a behavior or a config
  strategy is undecided. See [rfc/moq-publisher.md](../../../../rfc/moq-publisher.md).
- **Reconnect ownership** — engine behavior (a retrying session gate) vs
  adapter/consumer policy on top of `publish()`'s promise.

## Related features

- **`[moq-playback]`** *(candidate — no feature doc yet)* — the subscribe
  direction this feature complements: `playback/engines/moq/`, the
  `network/moqt` session/wire layer, and `media/moq`'s `loc.ts` /
  `parse-catalog.ts` that this feature's packaging/building round-trip
  against.
- **[capability-probing](./capability-probing.md)** — pattern sibling,
  not a dependency: `probeEncoderSupport` is the encode-direction analog
  of probe-before-commit (`isConfigSupported` playing `canPlayTrack`'s
  role), landing as a slot-writer behavior because encoder probing is
  async — the same sync-vs-async split that doc records for key-system
  probing.
- **[engine-adapter-integration](./engine-adapter-integration.md)** —
  `MoqPublishMediaMixin` follows the same one-engine-per-instance,
  `shareSignals` / `onSignalsReady` adapter shape as
  `SimpleHlsMediaMixin`.

## See also

- [clusters.md § Publish](./clusters.md#publish) — cluster heuristics
  this feature anchors
- [use-cases/moq-live-publish.md](../use-cases/moq-live-publish.md) —
  the delivery scenario composing this feature
- [rfc/moq-publisher.md](../../../../rfc/moq-publisher.md) — the proposal
  this slice implements (pending review)
- [`publish/engines/moq/engine.ts`](../../../../packages/spf/src/publish/engines/moq/engine.ts)
  (composition) ·
  [`publish/session/publish-session.ts`](../../../../packages/spf/src/publish/session/publish-session.ts)
  (protocol driver) ·
  [`publish/actors/track-publisher.ts`](../../../../packages/spf/src/publish/actors/track-publisher.ts)
  (group/backpressure mechanics)
