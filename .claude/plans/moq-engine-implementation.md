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
`draft-ietf-moq-loc-02`. Notable corrections to the plan's assumptions:

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

## Owed to Phase 0/5 (cannot be done in-repo)

- Interop matrix + evidence-based draft pin (plan §7 Phase 0). All wire
  specifics are quarantined in `network/moqt/`; a draft-16 compat
  profile would land there.
- Golden byte traces from real peers (tests currently round-trip
  against our own codec + in-memory fakes).
- Safari WebCodecs coverage probe; autoplay-gate UX.
- Live-relay e2e (opt-in flag), GOAWAY migration, CMSF/DRM.
- §6 prototype (2): MediaStreamTrackGenerator bridge comparison.
