---
status: implemented
date: 2026-08-05
definition: sketched
---

# Publisher multi-source capture

Evolve the MoQ publisher's capture contract from one exclusive source to
additive camera + screen, each independently acquirable, with the
microphone as its own always-on pipeline. This is the design record
[rfc/moq-publisher-multi-source.md](../../../../rfc/moq-publisher-multi-source.md)
(PR #12) calls for before implementation starts — it resolves the RFC's
open questions into a concrete contract and states what v1 defers.

## Problem, in code terms

Today `state.captureSource` (`packages/spf/src/publish/behaviors/dom/acquire-capture-source.ts`)
is one `CaptureSourceSelection`, owned by one `createMachineReactor`
(`'no-source' | 'source-selected'`) that acquires one `MediaStream`. The
media contract mirrors this: `MediaCaptureSourceCapability.captureSource`
(`packages/media/src/core/types.ts`) is a single
`MediaCaptureSourceKind | null`, and every consumer — the adapter
(`publish/engines/moq/adapter.ts`), the store feature
(`core/src/dom/store/features/capture-source.ts`), the screen-share button
and capture-placeholder cores — reads and writes that one field. Screen
capture's microphone is a merge-in on the audio-less `getDisplayMedia`
stream (`acquireSelection`'s screen branch), which is where the confirmed
`#reselectCamera()` defect lives.

Making camera and screen additive means capture stops being "one selection,
one stream" everywhere this touches: the contract, the acquisition
behavior, the encoder/catalog layer, and the surface widgets that read
`captureState/captureStream` as singular facts.

## Contract

**Recommendation: pluralize the existing capability's fields by kind,
rather than adding a second capability interface or a source-set/map.**

```ts
// packages/media/src/core/types.ts — MediaCaptureSourceCapability, replacing
// the single captureSource / captureState / captureStream trio.
export interface MediaCaptureSourceCapability {
  /** Camera acquisition; true acquires, false releases. Fires `capturesourcechange`. */
  cameraActive: boolean;
  /** Screen-share acquisition; true opens the OS picker, false stops sharing. Fires `capturesourcechange`. */
  screenShareActive: boolean;
  /** Camera pipeline lifecycle. Fires `capturestatechange`. */
  readonly cameraState: MediaCaptureState;
  /** Screen-share pipeline lifecycle. Fires `capturestatechange`. */
  readonly screenShareState: MediaCaptureState;
  /** Microphone pipeline lifecycle. Fires `capturestatechange`. */
  readonly micState: MediaCaptureState;
  /** Live camera stream while `cameraState` is `active`, else `null`. */
  readonly cameraStream: MediaStreamLike | null;
  /** Live screen-share stream while `screenShareState` is `active`, else `null`. */
  readonly screenShareStream: MediaStreamLike | null;
}
```

`MediaCaptureDevicesCapability` (`captureDevices`, `videoInputDeviceId`,
`audioInputDeviceId`) and `MediaCaptureToggleCapability` (`cameraMuted`,
`micMuted`) are unchanged in shape — the mic was already a sibling
concept there, not part of `captureSource`. Only its *acquisition* moves
off the fused path (see Capture, below).

This is a deliberate breaking change to a beta-line contract, which
[rfc/moq-publisher.md](../../../../rfc/moq-publisher.md) already flags as
acceptable pre-stable.

**Alternatives considered:**

- **A boolean beside the existing enum** (`captureSource` stays camera-only,
  a new `screenShareActive` sits beside it) — the RFC's own first sketch.
  Rejected: it leaves `captureState`/`captureStream` singular, so the same
  ambiguity (which source's state?) just moves one level down instead of
  resolving.
- **A second capability interface** (`MediaScreenCaptureCapability` beside
  `MediaCameraCaptureCapability`), composed the way `MediaAudioTrackCapability`
  / `MediaVideoTrackCapability` split by kind. Rejected for v1: it doubles
  the predicate/mixin surface (`isMediaScreenCaptureCapable`, a second
  `attach()` wiring point in the store feature) for two sources that are
  always present together on this one media host — no consumer needs to
  test for one kind's capability independent of the other. Revisit if a
  third independent source kind shows up; two sibling fields on one
  capability is the pattern `MediaCaptureToggleCapability` (`cameraMuted` /
  `micMuted`) already uses in this exact file.
- **A source set/map** (`sources: Map<CaptureSourceKind, {state, stream}>`)
  — most general, scales to N sources without another contract edit.
  Rejected: v1 caps at exactly camera + screen (the RFC's non-goals
  exclude further kinds), and every consumer becomes a lookup instead of a
  property read for a generality nothing here uses yet.

## Capture

`acquireCaptureSource` stops being one reactor over one selection. Genericize
it over kind and compose **three** independent pipelines:

- **Camera** — same machine-reactor idiom as today, keyed on `cameraActive`
  + `videoInputDeviceId`; `getUserMedia({video, audio: false})` (no more
  camera-path mic merge).
- **Screen** — same idiom, keyed on `screenShareActive`;
  `getUserMedia`→`getDisplayMedia({video: true, audio: false})` (see
  System audio, below, for why `audio: false`).
- **Microphone** — new pipeline **gated on either video source being
  active** (`cameraActive || screenShareActive` — the permission prompt
  stays tied to real capture intent, matching v1's UX; it is *not*
  unconditionally always-on) but keyed for re-acquisition on
  `audioInputDeviceId` ALONE. This is what fixes the confirmed defect: a
  mic device change re-acquires *only* this pipeline, never touching
  either video source, so `#reselectCamera()`'s early-return for screen
  sources has nothing left to special-case.

Each pipeline owns its own `MediaStream` and stale-async guard, following
the existing effect-in-positive-state shape. `syncPreview` and
`applyTrackToggles` each become kind-aware (mirror whichever stream a
`previewSource` intent selects; apply mute toggles per pipeline).

**Intent consumption (added after review):** `cameraActive` /
`screenShareActive` are multi-writer. The adapter records consumer
intent; the acquire behaviors *consume* it (write `false`) when the
pipeline terminates without consumer action — permission `denied`, or
`ended` out of band (device unplugged, browser-native "Stop sharing").
The terminal status survives the release for UI messaging. This is
load-bearing for two review-confirmed defects: without it the mic's
OR-gate holds the microphone hot behind a dismissed screen picker, and a
`true` re-write after a denial dedupes into a no-op so no UI gesture can
ever retry.

**Microphone failure policy (added after review):** missing/unsatisfiable
mic (`NotFoundError`/`OverconstrainedError`) lands a quiet `idle` with no
`publishError` — a mic-less machine publishes video-only, as the old
fused model guaranteed; an exact `audioInputDeviceId` that fails falls
back to the platform default. A mic parked in `ended` or that quiet
`idle` re-acquires on `devicechange` while the gate is active (replug
recovery). The mic's lifecycle is readable as `micState` on
`MediaCaptureSourceCapability` (and the store slice) so UIs can say why a
live broadcast has no sound; only its lifecycle is exposed — the mic has
no intent slot.

## Encode / publish

`ActiveEncodingsFacts` (`setup-track-publishers.ts`) becomes keyed by kind
rather than the RFC's literal "list," since camera and screen need
distinct, named tuning, not an order:

```ts
export interface ActiveEncodingsFacts {
  camera?: VideoEncoderConfig;
  screen?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}
```

`setupTrackPublishers`' additive-by-kind logic already generalizes for
free — it was written to add a publisher whenever a new key appears in
`activeEncodings` and never tear one down mid-session, which is exactly
what a screen share starting or stopping mid-session needs. Two new track
name constants land beside `VIDEO_TRACK_NAME`: keep `VIDEO_TRACK_NAME =
'video'` for the camera (no wire-format churn for existing subscribers)
and add `SCREEN_TRACK_NAME = 'screen'`. `catalogInputFor` gains a `screen`
branch; both video tracks publish in one `renderGroup` per the RFC
(never `altGroup` — that seam stays reserved for simulcast).

**Catalog latching (added after the mic-switch sync bug):** the catalog
advertisement is latched the same way the track publishers are. A device
switch re-acquires cleanup-first, so the kind's probe verdict — and with
it `activeEncodings[kind]` — vanishes for the length of the re-probe. The
MOQT track publisher survives that transient by design (above), but a
catalog derived from the encodings alone re-published without the track
and then re-added it, and subscribers obey catalogs: every mic switch
tore down the viewer's audio subscription and re-joined it at the live
edge (`largest-object`), where the audio renderer — the master clock —
re-anchored at ~zero latency and dragged the whole presentation with it.
That was measured as "audio jumps toward real-time and A/V drifts after
switching mics." `deriveCatalog` therefore keeps a kind advertised with
its last-known config while its capture status is `'active'` or
`'acquiring'` **and** the kind has no completed probe verdict
(`encoderSupport[kind]` — the probe clears it with the encoding on a
re-probe and re-commits it even when the ladder is empty or the selection
strategy vetoes the kind, so its presence distinguishes "answered: not
encodable" from "still probing"); drops the kind when the status parks
anywhere else, when a completed probe selected nothing, or when the
catalog publisher is replaced (a rebuilt session re-latches its per-kind
PUBLISHes from the current encodings, so held kinds must not outlive the
publisher they were advertised on); and deduplicates byte-identical
catalog sends per publisher. **Known follow-up:** because the catalog no longer flaps, a switch that resolves
to a *different* config (mono mic → stereo) updates the catalog entry
in place, and a subscriber that diffs tracks by id alone keeps its
decoder config until it re-reads the entry — the viewer-side
config-identity diff is tracked as its own piece of work.

**Encoder budget (resolved):** no adaptive policy in v1. The screen
encoder gets its own lower-bandwidth default config via the existing
`video` config seam extended with a `screen` sibling — a static
degrade-screen-first default, not a runtime policy engine. Matches the
RFC's own "Screen encoding gets its own tuning" bullet; a dynamic
encoder-budget policy is deferred (see Non-goals). Implemented knobs:
lower framerate + bitrate (`screenCandidates`) and the `detail`
`contentHint` on the acquired screen track. **Deliberately not
implemented:** a cheaper (longer) screen keyframe cadence —
`groupDurationSec` stays uniform across kinds because each GoP is one
MoQ group and group boundaries gate subscriber join latency; lengthening
only the screen GoP would make screen tracks measurably slower to join
with no measured bandwidth need. Revisit with data, in
`pump-media-frames`' cadence seam.

## Surface

- **Store** (`capture-source.ts`): `selectCaptureSource(kind)` is replaced
  by `toggleCamera()` / `toggleScreenShare()` (the latter already exists;
  its semantics change from "swap exclusive source" to "toggle screen
  independently" — call sites are unaffected). State fields become
  `cameraActive`, `screenShareActive`, `cameraState`, `screenShareState`,
  and (added after review) the read-only `micState`.
- **`screen-share-button-core.ts`**: `sharing` becomes
  `media.screenShareActive` directly, replacing
  `media.captureSource === 'screen'`.
- **`capture-placeholder-core.ts`**: the placeholder is shown before
  *any* source is active — `captureState` becomes a derived aggregate,
  `active` if either `cameraState` or `screenShareState` is `active`,
  else the more "in-progress" of the two (`acquiring` > `denied` >
  `ended` > `idle`, matching today's single-source precedence).
- **Preview (resolved):** one switchable preview in v1 — a
  `previewSource: 'camera' | 'screen'` intent (default `'camera'`)
  selects which stream `syncPreview` mirrors into the attached preview
  element. The contract already exposes both streams
  (`cameraStream`/`screenShareStream`), so a picture-in-picture or
  dual-slot surface is additive later without another contract change;
  building it is out of scope here (matches the RFC's stated non-goal on
  first-party multi-view).

## Resolved open questions

The RFC left four open; each has a v1 answer below, with the reasoning
that made deferring the rest safe.

| Question | v1 answer |
| --- | --- |
| Preview UX | Single switchable preview (`previewSource` intent); dual-slot/PiP deferred — both streams are already exposed for a later surface to consume. |
| System audio | Request `getDisplayMedia({video: true, audio: false})` — never acquire it. A `screen-audio` MOQT track is real scope (new encoder, catalog entry, subscriber contract) the RFC's non-goals don't ask v1 to carry; revisit if a product need surfaces. |
| Subscriber labeling | Track-name convention only (`screen`), per the RFC's own Recommendation bullet — no MSF `role` field or extension. A formal signal is only worth the wire-format churn once interop beyond this publisher needs it. Note (added after review): the *parse* side does not depend on the name — camera and screen land in separate switching sets because neither declares MSF `altGroup` (alternates of one content item), which this catalog deliberately never emits for distinct sources; the name only surfaces in the derived switching-set id (`moq-video-screen`). |
| Encoder budget | Static degrade-screen-first defaults via a config seam, no adaptive policy (see Encode/publish, above). |

## Non-goals (v1)

Matches [rfc/moq-publisher-multi-source.md](../../../../rfc/moq-publisher-multi-source.md)'s
non-goals (simulcast, composition/layout tooling, non-Chromium capture),
plus what this record defers beyond the RFC:

- `screen-audio` as a published track (system audio is dropped, not
  captured).
- A formal subscriber-facing track-role signal beyond the name convention.
- Dynamic/adaptive encoder-budget policy.
- Dual-preview or picture-in-picture surface components.

## Implementation surface

- `packages/media/src/core/types.ts` — `MediaCaptureSourceCapability`,
  `isMediaCaptureSourceCapable`'s shape check.
- `packages/spf/src/publish/behaviors/dom/acquire-capture-source.ts` — split
  into camera/screen/mic pipelines.
- `packages/spf/src/publish/behaviors/dom/sync-preview.ts`,
  `apply-track-toggles.ts` — kind-aware.
- `packages/spf/src/publish/behaviors/dom/probe-encoder-support.ts`,
  `setup-encoder-actors.ts`, `pump-media-frames.ts` — a second video
  encoder/pump pair for `screen`.
- `packages/spf/src/publish/behaviors/setup-track-publishers.ts`,
  `derive-catalog.ts` — `SCREEN_TRACK_NAME`, keyed `ActiveEncodingsFacts`.
- `packages/spf/src/publish/engines/moq/{engine,adapter}.ts` — new
  intent/fact slots, adapter properties (`cameraActive`, `screenShareActive`,
  `previewSource`, plural state/stream getters).
- `packages/core/src/dom/store/features/capture-source.ts`,
  `packages/core/src/core/ui/{screen-share-button,capture-placeholder,enable-devices-button}/*-core.ts`.

## See also

- [rfc/moq-publisher-multi-source.md](../../../../rfc/moq-publisher-multi-source.md) — the proposal this record decides
- [rfc/moq-publisher.md](../../../../rfc/moq-publisher.md) — v1's exclusive-source scope and the `config.video`-as-array seam this builds on
- [moq-publish.md](./moq-publish.md) — the feature this extends; its Signals/Implementation-surface inventories are the v1 baseline every row above changes
- [use-cases/moq-live-publish.md](../use-cases/moq-live-publish.md) — the delivery scenario composing this feature
