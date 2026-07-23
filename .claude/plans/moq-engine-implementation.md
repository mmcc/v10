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

## Owed to Phase 0/5 (cannot be done in-repo)

- Interop matrix + evidence-based draft pin (plan §7 Phase 0). All wire
  specifics are quarantined in `network/moqt/`; a draft-16 compat
  profile would land there.
- Golden byte traces from real peers (tests currently round-trip
  against our own codec + in-memory fakes).
- Safari WebCodecs coverage probe; autoplay-gate UX.
- Live-relay e2e (opt-in flag), GOAWAY migration, CMSF/DRM.
- §6 prototype (2): MediaStreamTrackGenerator bridge comparison.
