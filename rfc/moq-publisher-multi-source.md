---
status: implemented
---

# MoQ Publisher Multi-Source Capture

Publish camera and screen share as simultaneous MOQT tracks in one session, replacing v1's exclusive capture-source swap. Supplements [moq-publisher.md](./moq-publisher.md); it does not supersede it.

## Problem

The v1 publisher models capture as one exclusive source: `MediaCaptureSourceCapability` holds a single `captureSource` (`'camera' | 'screen'`), and `acquire-capture-source` owns exactly one `MediaStream`. Starting a screen share therefore *stops publishing the camera*, and the microphone is kept alive by merging it into the audio-less display stream.

This shape has three costs:

- **Product**: talking-head-plus-screen — the default layout for presentations, webinars, and creator streams — cannot be published at all. Subscribers cannot choose between sources because the publisher was forced to choose at capture time.
- **Correctness**: the fused-stream workaround is where a confirmed defect class lives. Changing `audioInputDeviceId` during a share updates the device picker but not the outgoing audio (`#reselectCamera()` returns early for screen sources), and fixing it inside the fused model means re-acquiring via `getDisplayMedia`, which re-prompts the OS screen picker on every mic change.
- **Architecture**: it fights MOQT's grain. Subscription is per-track and pull-based — relays fan out only what is subscribed, and composition is meant to be the subscriber's decision. Fusing sources into one track moves that decision to the wrong end of the wire.

## Customer salience

Camera + screen simultaneously is table stakes for any product with a "share your screen" button next to a live camera: webinars, sales demos, pair-streaming, remote teaching. Per-track delivery is also MoQ's differentiator over WebRTC SFU pipelines — a viewer on constrained bandwidth subscribes to the screen track alone; a multi-view UI subscribes to both — so shipping a publisher that collapses sources into one track forfeits the protocol's core selling point.

## Options considered

- **Compose client-side into one track** (canvas/`OffscreenCanvas` mixing camera over screen) — what fused WebRTC apps do. Keeps v1 contracts untouched, but burns publisher CPU on composition, bakes the layout at capture time, and permanently denies subscribers per-track choice. Reversible but a dead end for the protocol's model.
- **Two publisher instances** (one per source) — no contract change, but two sessions, two namespaces, two auth tokens, split stats, no shared lifecycle, and ambiguous microphone ownership. Punts the hard part (one coherent publisher UI) to every integrator.
- **Additive capture sources → separate tracks in one session (recommended)** — camera, screen, and microphone become independent capture pipelines feeding independent encoders and track publishers under one namespace and catalog. The moqt layer already supports this: PUBLISH is per track with its own alias, track publishers carry per-track group/backpressure accounting, PUBLISH_DONE ends one track without touching the others, and `deriveCatalog` re-announces a full independent catalog whenever the active encodings change — a track appearing or disappearing mid-session already round-trips. The v1 RFC reserved exactly this seam ("`config.video` as an array").

## Recommendation

Adopted the additive-source model. At the level that needed agreement:

- **Contract (the public-API crux)**: `MediaCaptureSourceCapability` evolves from one exclusive `captureSource` slot to additive sources — camera and screen each independently acquirable and releasable, microphone owned separately. The exact shape (a `screenShareActive` boolean beside the existing `captureSource`, versus a source set) belongs to the follow-up design record, but the *semantics* decided here are: starting a share no longer releases the camera, and stopping one source never re-prompts another. The affected packages are still in the v10 beta line (`10.0.0-beta.x`), where a deliberate breaking change to a capability contract is acceptable before stable; the v1 swap behavior stays recoverable by releasing the camera before acquiring the screen.
- **Capture**: per-source acquisition pipelines replace the single-stream behavior. The microphone merge disappears; a mic device change re-acquires only the mic pipeline, which fixes the open defect by construction rather than by patching the fused path.
- **Encode/publish**: `activeEncodings` video becomes a list; the catalog names the tracks `video` (camera) and `screen`, both in one `renderGroup` with the audio track — *not* `altGroup`, which marks alternates of the same content (that seam stays reserved for simulcast). Screen encoding gets its own tuning (content hint, lower framerate, keyframe cadence).
- **Stats**: per-track legs instead of one video leg, building on the just-landed NaN-as-unknown semantics so absent tracks read as unknown, not zero.
- **Surface**: the screen-share control becomes an additive toggle; publish stats and the connection indicator aggregate across tracks.
- **Subscriber side**: catalog video tracks already land in the player's track-selection surface, so a second player subscribing to the `screen` track works today; a first-party multi-view surface is explicitly out of scope.

Non-goals: simulcast (same array seam, separate proposal); composition/layout tooling; Firefox/Safari capture support (v1's Chromium pin stands).

### Open questions

- **Preview UX**: one preview element cannot show two sources. Picture-in-picture preview, source-switchable preview, or two preview slots?
- **System audio**: `getDisplayMedia` can return tab/system audio. In v1 a share that comes back with audio *keeps* it and the microphone is never acquired; the mic is merged only when the share is audio-less (`acquire-capture-source.ts`). With the mic as its own always-on track, does system audio become a separate `screen-audio` track, get mixed, or get dropped?
- **Subscriber labeling**: how does a subscriber distinguish the screen track semantically — track-name convention (`screen`), an MSF `role` value, or a documented extension field? Affects default track-picker behavior when a catalog carries two non-alternate video tracks.
- **Encoder budget**: two simultaneous encodes on constrained hardware — degrade the screen track first, or expose the policy?

## Final decision

Accepted and implemented. `MediaCaptureSourceCapability` now exposes additive `cameraActive` / `screenShareActive` booleans, each with independent `cameraState` / `screenShareState`, instead of one exclusive `captureSource` slot — the microphone is its own always-available pipeline gated on either video source. See [publisher-multi-source-capture.md](../internal/design/spf/features/publisher-multi-source-capture.md) for the resolved contract (including why a boolean-beside-the-enum and a source set were rejected) and the implementation surface; it resolves the open questions above as well.
