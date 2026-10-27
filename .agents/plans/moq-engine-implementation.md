# MoQ Engine — Implementation Notes

Implements the plan at `spf-moq/PLAN.md` (2026-07-17 revision). Branch:
`mmcc/moq`. This note records what landed, where it deviates from the
plan, and what Phase 0/5 still owes.

## What landed (per plan phase)

| Plan item | Status | Where |
|---|---|---|
| §5 type-model change | ✅ | `media/types` — `TrackDeliveryMode` + `LiveOf<T>` (extends `PartiallyResolved<T>`, zero HLS ripple; audit confirmed selection reads only metadata) |
| Phase 1 wire protocol | ✅ | `network/moqt/` — vi64 varint, control messages, request streams, object streams, session driver; 51 tests incl. spec Table 2 golden vectors |
| Phase 2 format layer | ✅ | `media/moq/` — parse-source (msf: fragment), parse-catalog (independent + delta), loc, codec-mapping, timeline; 46 tests |
| Phase 3 actors/behaviors | ✅ | `playback/actors/{moq-session,track-subscriber}`, `playback/actors/dom/{video,audio}-renderer`, `playback/behaviors/{setup-moq-session,resolve-catalog,subscribe-selected-tracks,sync-latency,track-moq-bandwidth}`, `behaviors/dom/setup-moq-renderers` |
| Phase 4 engine + adapter | ✅ | `playback/engines/moq/` — `createMoqEngine`, `MoqMediaMixin` (canvas facade, §6 prototype 1), `./moq` export, `--moq` size flag |
| Phase 0 interop matrix | ❌ not runnable here | needs live relays; see "Owed to Phase 0/5" |
| Phase 5 hardening | ❌ | CMSF, GOAWAY reconnect, error slots, docs page |

Size baseline (2026-07-17): MoQ entry 18.16 KB min+gzip (90.8% of the
20 KB budget); HLS entry unchanged (13.55 KB).

## Wire-protocol grounding

Implemented against the actual spec texts (fetched 2026-07-17):
`draft-ietf-moq-transport-19`, `draft-ietf-moq-msf-01`,
`draft-ietf-moq-loc-02` (LOC moved to loc-04 in PR #9). The spec texts are
now vendored under `internal/specs/moq/` (transport-20, loc-04, msf-01 as of
2026-09-02); the draft-20 migration plan is `moq-transport-20-migration.md`
beside this file. Notable corrections to the plan's assumptions:

- **Varint is NOT the QUIC RFC 9000 varint.** Draft-15+ uses a
  leading-ones vi64 (1–9 bytes). Spec Table 2 vectors are test fixtures.
- **Version negotiation is connection-level** (ALPN /
  `WT-Available-Protocols`, `moqt-19`), not in SETUP. SETUP (0x2F00) is
  options-only, sent on paired *unidirectional* control streams.
- **Values above 2^53-1 are rejected** (`MoqtProtocolError`) rather than
  silently truncated; nothing a subscriber consumes needs more.

## Deviations from the plan (deliberate)

- `syncPreload` / `trackLoadTriggers` are not composed into the engine:
  both are `HTMLMediaElement`-bound and there is no element; the adapter
  writes `state.preload` / `state.loadActivated` directly.
- Audio renderer uses `AudioBufferSourceNode` scheduling, not the
  AudioWorklet ring buffer, with the clock contract already shaped for
  the swap (TODO(audio-worklet) in `audio-renderer.ts`).
- No text-track subscription behavior yet (`switchTextTrack` composes
  and selects, but nothing renders text).
- No WebCodecs `canPlayTrack` probe is injected into selection —
  `isConfigSupported` is async and `CanPlayTrack` is sync. The plan's
  full-pipeline capability gate (incl. the video-only-fallback policy)
  is an open Phase 4 decision.
- Track ids are stable serialized full track names (not `generateId()`):
  live catalog re-parses must not churn selection identity.
- Catalog namespace strings in JSON are split on `/` into tuple fields —
  msf-01 doesn't specify the tuple encoding inside the catalog;
  flagged for interop verification.
- LOC property IDs: only Timestamp (0x06) / Timescale (0x08) /
  Video Config (13) are interpreted; loc-02's pre-IANA Frame Marking /
  Audio Level ids collide with Timestamp.

## Review triage (2026-07-23, PR #1 bot reviews)

46 findings (Codex + cubic) triaged: 28 confirmed and fixed, 8 invalid,
5 deferred, plus 5 duplicates across the two bots. Notable outcomes:

- Fixed P1s: media subscriptions now gate on `loadActivated || preload
  === 'auto'`; latency catch-up re-anchors renderer clocks (was an
  infinite silence/freeze loop); LOC Video Config extradata reconfigures
  the video decoder; delta catalogs resolve `initRef`; `connection=q`
  is rejected (native QUIC not implementable in browsers).
- Make-before-break promotion now waits until the pending track is due
  at the playout clock — the residual ~60ms audio gap at swap (schedule
  margin + decode) is deferred alongside the AudioWorklet TODO.
- Deferred as Phase 5 protocol strictness (all decode-side leniency,
  no corruption or hang possible): duplicate non-repeatable parameters,
  out-of-context parameters, full-track-name 4096 limit, server request
  ID parity/reuse validation.
- Deliberate stances re-affirmed against review pressure: varint 2^53-1
  rejection (documented above); keep-playing on transiently-invalid
  track selection; text selection composes with no renderer (TODO
  marker added in the engine).

## Review triage round 2 (2026-07-23, cubic follow-up on the fixes)

7 findings on the round-1 fixes: 6 fixed, 1 deferred.

- Audio `getPlaybackRate` no longer gates to 0 on pause — rate 0
  scheduled an infinite clock segment (duration ÷ 0) and sources whose
  `playbackRate` stayed 0 after resume. Pause-freezing audio is the
  adapter's `AudioContext.suspend()` alone. The video self-clock keeps
  the rate-0 gate, hardened two ways: `present()` reads the clock even
  with an empty decoded queue (so a pause folds into the anchor
  immediately, not when the next frame decodes), and the discontinuity
  re-anchor is skipped at rate 0 (live-edge frames arriving mid-pause
  no longer present).
- Bandwidth arrivals: first object only establishes the timing
  baseline; its bytes are excluded so the first sample doesn't
  overstate throughput.
- A transport drop before server SETUP now surfaces through `onClosed`
  as an error (session actor → `failed`); a deliberate local `close()`
  stays a clean close.
- resolve-catalog auth retry: `.catch()` chained after `.then()` so a
  synchronous throw from re-subscription is contained.
- Deferred: byte-preserving (non-UTF-8) MSF track/namespace names.
  Names are JS strings end-to-end (catalog JSON, `utf8Encode` on the
  MOQT wire), so a non-UTF-8 name can't round-trip anywhere in the
  pipeline; the fatal decode error is preferred over silent byte
  corruption. Revisit with the interop phase if a real publisher uses
  binary names.

## Player-shell event bridge (2026-07-23)

The `SimpleMoqVideo` wrapper now satisfies core's capability-probed
`Media` contract so store features attach and sync — the key insight
being that core features probe capabilities (`isMediaPauseCapable`,
`isMediaLiveCapable`, …) and listen to plain events, so the
signals→events translation lives entirely in `packages/html` (the
google-cast provider precedent), not in SPF:

- Wrapper (`packages/html/src/media/simple-moq-video/`): capability
  properties (`ended`/`seeking`/`readyState`/`currentSrc`/`load`/
  `streamType`/`liveEdgeStart`/`targetLiveWindow`/`error`/video
  dimensions) plus an event bridge — `effect()` on the `paused` slot
  (`play`/`pause`), `effect()` on presentation resolution
  (`loadedmetadata`), a 250ms poll of the audio master clock
  (`timeupdate`, stall→`waiting`, resume→`playing`/`canplay`), and
  native load-cycle events from the `src` setter.
- Deliberately unclaimed capabilities: `buffered`/`seekable` (no buffer
  model surfaced yet), `playbackRate` (live-only), `textTracks` (no
  text renderer — engine TODO).
- Seeks resolve immediately via a deferred `seeked` (live-only, no
  seekable window) so `timeFeature.seek()` flows don't hang.
- SPF adapter grew only engine-legit surface: `volume`/`muted` backed
  by a `GainNode` spliced in by handing the renderer an
  `AudioContextLike` view whose `destination` is the gain node
  (`MoqAudioContext` gained `createGain`). No renderer changes.
- Engine error slot still missing → wrapper claims the error capability
  with a constant `null`; wire it once the engine surfaces errors.

## First browser bring-up (2026-07-28)

`apps/sandbox/templates/spf-moq-player/` — `<simple-moq-video>` inside a
real `<live-video-player>` + `live-video-skin`, with an engine-state
diagnostics panel, a capability readout, and an event log. Verified in
Chromium: session ready → catalog resolved (2 video + 1 audio) → ABR
pick → subscribe → decode → canvas + audio master clock, `readyState` 4,
`currentTime` advancing, play/pause/mute driving the store, LIVE badge,
and a rendition switch completing make-before-break (canvas resizes on
promotion). Zero page errors.

- **Loopback publisher** (`loopback-relay.ts`): there is no MSF-catalog
  relay to point at, so the page ships a synthetic one — hand-rolled
  draft-19 bytes (vi64, SETUP/SUBSCRIBE_OK/REQUEST_ERROR, subgroup +
  LOC framing) over an in-memory `MoqtTransport`, publishing real
  WebCodecs-encoded VP8 (two renditions) + Opus. Written from the specs
  rather than reusing `network/moqt`'s encoders: it is a second
  independent implementation, so it checks the decoder rather than
  round-tripping against ourselves. `?relay=moqt://…#msf:…` swaps in a
  real relay.
- **Adapter seam**: `MoqMediaOptions.engineConfig` forwards engine config
  (transport factory, ABR/latency tuning) through the element
  constructor; the adapter still owns `onSignalsReady`. Without it there
  was no way to reach `createMoqTransport` from outside SPF.
- **Skin layout parity**: the wrapper's canvas is now styled by a shadow
  stylesheet with `:host { display: contents }` and the same
  `--media-object-fit` / `--media-video-border-radius` hooks
  `CustomMediaElement` gives a `<video>`. Previously the inline
  `height: 100%` resolved against an inline host and the picture
  collapsed to the canvas's intrinsic height inside a skin.
- **Two bugs the bring-up caught**, both from writing the publisher
  independently: an empty KVP block is *length-bounded, not counted*
  (a zero count byte made SETUP undecodable), and the server's control
  stream must stay open for the session's lifetime (closing it after
  SETUP trips "peer closed its control stream", §3.3).
- **Pre-existing bug fixed**: all four `live-*` define entries
  (`live-video`/`live-audio`, full + minimal) registered `TooltipElement`
  but never `TooltipLabelElement`/`TooltipShortcutElement`, so every
  tooltip in a live skin threw `setSyncedText is not a function`.
  Reproduced on the existing HLS-live sandbox page, so it predates MoQ.
- Rough edge, not addressed: the PiP button renders and is clickable but
  does nothing (canvas-backed media has no `requestPictureInPicture`) —
  core's PiP availability keys off `document.pictureInPictureEnabled`,
  not the media's capability. Harmless no-op, no error.
- Sandbox gotcha for future sessions: `templates/` mirrors to the
  gitignored `src/` only at dev-server `buildStart`. Editing a template
  while the server runs changes nothing until `tsx scripts/setup.ts`
  re-runs.

## Sandbox review triage (2026-07-28, PR #2 bot reviews)

10 bot findings across four rounds plus 3 self-review fixes — all valid,
all fixed. Three further Codex comments were stale re-posts of
already-fixed findings (each named `loadLatestSkin`, a symbol the commit
under review had removed); every thread got a reply with the resolution
or the before/after evidence.

Every finding was in the harness page, not the engine — the sandbox is
where untrusted input (query params) and lifecycle churn (mode/skin
switching) live. The recurring theme is worth remembering: **the page
kept approximating contracts the engine already owns**, and each
approximation was wrong in a way that produced a mounted-but-silent
player rather than an error.

- Query params were cast, not validated: `?skin=bogus` resolved to an
  undefined skin tag (so `document.createElement(undefined)` produced an
  `<undefined>` wrapper with no chrome) and `?latency=foo` wrote NaN into
  the latency controller. Both now fall back.
- `checkSupport()` demanded encoders and `OffscreenCanvas` in *both*
  modes, so a browser able to play a real relay was turned away for
  lacking publisher-only APIs. The check is mode-scoped and moved into
  `render()` so it tracks runtime mode switches.
- Two lifecycle leaks on unmount: the module-level relay reference, and
  the rendition buttons, whose handlers close over the media element and
  stayed clickable against a destroyed engine until the next catalog
  resolved.
- `render()` had a supersede gap the latest-loader could not see: the
  missing-APIs early return never advanced the loader version, so a call
  still awaiting its skin import resumed afterward and mounted for the
  just-rejected mode — verified by reproducing it, a `simple-moq-video`
  mounted *underneath* the "missing WebTransport" banner. Replaced with a
  render generation bumped on every entry, early returns included.
- The documented `?relay=moqt://…#msf:…` form could never work: the
  browser takes everything from `#` as the page fragment, so the engine
  received a fragment-less source and only logged a dev warning behind an
  empty player. The page now recombines its own `#msf:` fragment and
  reports a relay URL that still isn't a valid MSF source.
- The relay-URL guard approximated the source contract (scheme plus
  `#msf:`), so URLs `parseMoqSource` rejects — no `--` delimiter, bad
  name escapes, `connection=bogus` — passed the page and failed later
  inside the engine. It now calls `parseMoqSource`, which is newly
  exported from `@videojs/spf/moq` for the purpose (10 bytes: already
  bundled, only the export is new).
- Codec support was inferred from the WebCodecs constructors existing. A
  platform that rejects the publisher's VP8/Opus configs passed the
  check, then `configure()` threw inside the subscribe handler, where the
  request-stream loop's catch absorbed it as a subscriber abort — a
  subscription that closed with nothing explaining the silence. Both
  directions of every published config are probed with
  `isConfigSupported()` (a throwing probe counts as unsupported), and a
  producer that fails to start is reported.
- A11y: `#logs` gained `role="log"` and a label so appended entries
  announce, and the relay input — the page's only unlabelled control —
  gained a real `<label for>`.

Measured while fixing: **the MoQ entry is at 97.7% of its 20 KB budget
(19.55 KB, 465 B left)**, not the 18.16 KB recorded above — the drift is
from this branch's earlier fix rounds, not the sandbox. Worth knowing
before the next MoQ change.

## Live-relay interop: relay.mux.dev (2026-07-30)

First real Phase 0 data point — a moq-dev relay deployment reachable at
`relay.mux.dev`, broadcasting a live test pattern at
`moqt://relay.mux.dev/#msf:anon--catalog`. Drove `SimpleMoqVideo`
end-to-end against it (new sandbox template
`apps/sandbox/templates/moq-relay-interop/`, a debug harness with an
engine-state/log panel — no demo page existed before this). Two real
protocol gaps found and fixed; playback now works (canvas renders the
relay's test pattern, bandwidth/clock/playout state all tracking
correctly):

- **`PUBLISH_NAMESPACE` (0x6) had a defined `MESSAGE_TYPE` constant but
  no decode case** — `control-messages.ts`'s decode switch fell to
  `default` and threw, which killed the whole session, because the
  relay announces its namespace unsolicited right after SETUP (before
  we ever send SUBSCRIBE_NAMESPACE). Fixed: added the decode case
  (`kind: 'publish-namespace'`) plus `encodePublishNamespace` for
  symmetry/tests. No session.ts change needed — `#handleIncomingRequest`'s
  existing generic fallback (REQUEST_ERROR/NOT_SUPPORTED for any
  non-`'publish'` incoming request) already does the spec-correct thing
  once the message decodes instead of throwing.
- **relay.mux.dev answers FETCH with generic REQUEST_OK, not the
  spec-mandated FETCH_OK** (draft-19 §10.12.3: "responds ... with
  either a FETCH_OK or a REQUEST_ERROR"; §10.5's REQUEST_OK list
  doesn't include FETCH) — a relay-side deviation, not our bug. Was
  fatal (`#handleFetchMessage`'s catch-all). Fixed with a deliberate
  leniency case: `'request-ok'` is now a no-op on a fetch stream rather
  than fatal. Safe because `onOk`'s `endLocation`/`endOfTrack` aren't
  consumed by any current caller (only `resolveCatalog`'s joining fetch
  calls `session.fetch()` today, and it only uses
  `onEntry`/`onEnd`/`onError`/`onReset`) and because the fetch's actual
  data delivery is a *separate* unidirectional stream, decoupled from
  whatever the bidi request stream's response says (confirmed by an
  existing test that never even sends FETCH_OK and still passes).

Both fixes are covered by new tests in `control-messages.test.ts` and
`session.test.ts`. The sandbox template is a reusable harness for any
future relay interop check — point `src`/query-param `?src=` at a
different `moqt://` URL to test another deployment.

## Owed to Phase 0/5 (cannot be done in-repo)

- Interop matrix + evidence-based draft pin (plan §7 Phase 0) — one
  live relay now verified (relay.mux.dev, above); still need a broader
  matrix across other moq-dev/relay implementations.
- Golden byte traces from real peers (tests currently round-trip
  against our own codec + in-memory fakes).
- Safari WebCodecs coverage probe; Safari-device verification of the
  autoplay gesture unlock. (Autoplay itself landed in-repo:
  `<simple-moq-video autoplay>` starts video on the self-clock and defers
  the audio subscription behind the engine's `audioSuspended` gate until
  the first user gesture resumes the AudioContext — verified against
  headless Chromium's strict autoplay policy.)
- GOAWAY migration, CMSF/DRM.
- §6 prototype (2): MediaStreamTrackGenerator bridge comparison.
