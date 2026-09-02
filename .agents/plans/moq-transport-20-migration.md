# MoQ transport draft-20 migration plan

Planning pass dated 2026-09-02. `draft-ietf-moq-transport-20` was published
2026-08-31 and is vendored at `internal/specs/moq/draft-ietf-moq-transport-20.txt`
(its Appendix A.1 is the authoritative change list). The code on `mmcc/moq`
and `mmcc/moq-publisher` pins draft-19 (`MOQT_PROTOCOL_ID = 'moqt-19'`).
LOC-04 and MSF-01 did not change; loc.ts already uses the loc-04 property IDs
that draft-20 §15.8 now mirrors, so no LOC/MSF code moves.

The relay fleet (mux.global and relay.mux.dev, both updated 2026-09-02) runs
moq-relay 0.14.14, released 2026-09-01, which added `moqt-20` in moq-dev/moq
PR #3255. The update does not affect our draft-19 sessions: the relay keeps
its old behavior on `moqt-19` (current-group replay, no LARGEST_OBJECT). That implementation is the
only draft-20 peer we talk to, so this plan follows its wire behavior where
the spec text is ambiguous, and calls out each place it does.

Temporary implementation notes — delete before merge per `AGENTS.md`.

## What changed on the wire (draft-19 → draft-20)

Section numbers are draft-20's. Everything after §10.9 shifted by one
because §10.10 PUBLISH_STATE_NOTIFY was inserted; §5.1.3 Fill Semantics
shifted §5.1.3–5.1.5 too.

| Change | Spec | Kind | Affected code |
| --- | --- | --- | --- |
| ALPN / `WT-Available-Protocols` value becomes `moqt-20` | §3.1 | breaking | `MOQT_PROTOCOL_ID`; `moq-session.ts` actor passes it to `WebTransport` |
| LOCATION_FILTER re-encoded: no Filter Type; length-counted optional `StartGroup, StartObject, EndGroupDelta, EndObject` | §5.1.2, §10.2.9 | breaking | `LocationFilter`, `encodeLocationFilter`, `decodeLocationFilter` |
| Publishers honor filters to the object: a Next Object subscription starts mid-group; a subscription no longer ends when Largest Object passes its end | §5.1.2 | behavior | catalog and audio joins that relied on relays replaying the current group (see below) |
| FETCH loses Fetch Type + Standalone/Joining structures; body is `Request ID, Namespace, Name, Parameters`; range travels in LOCATION_FILTER | §10.13 | breaking | `FetchRequest`, `encodeFetch`, FETCH decoder, `MoqtFetchOptions`, `session.fetch()` |
| Joining FETCH replaced by **fill fetch streams** requested with `FILL_PARAMETERS` (0x23) | §5.1.3, §10.2.15 | breaking (behavior) | `resolve-catalog.ts` catalog join; `session.ts` if we ever request fills |
| New `PUBLISH_STATE_NOTIFY` (0x22) on subscription streams, parameters-only, no reply | §10.10 | additive but fatal if unknown | `MESSAGE_TYPE`, decoder, `#handleSubscriptionMessage` |
| New `INCLUDE_PROPERTIES` (0x35) | §10.2.21 | additive but fatal if unknown | `PARAMETER_TYPE`, `MessageParameters` codec |
| `LARGEST_OBJECT` becomes something the relay actually sends in SUBSCRIBE_OK | §10.2.17 | interop | `decodeMessageParameters` framing (see relay facts) |
| FETCH_OK End Location is "the end of the range covered", from the request's Location Filter (inclusive) | §10.14 | semantic | `FetchOk.endLocation` consumers (none in playback) |
| Fetch stream `End of Timed-Out Range` (0x20C) joins 0x8C / 0x10C | §11.4.4, §10.2.5 | additive but fatal if unknown | `readFetchEntries`, `FetchStreamEntry.status` |
| SUBGROUP_HEADER / OBJECT_DATAGRAM types described as Type Flags; ≥128 or any unspecified bit is PROTOCOL_VIOLATION | §11.3.1, §11.4.2 | none (already equivalent) | comments in `object-stream.ts`, `subgroup-writer.ts` |
| PUBLISH_DONE: `SUBSCRIPTION_ENDED` (0x3) removed; unknown Stream Count sentinel is 2^64−1; count includes fill streams | §10.12 | semantic | `PUBLISH_DONE_STATUS`, Stream Count decode |
| REQUEST_ERROR `INVALID_JOINING_REQUEST_ID` (0x32) removed | §15.11.2 | cleanup | `REQUEST_ERROR_CODE`, `PERMANENT_REQUEST_ERROR_CODES` |
| Session error `VERSION_NEGOTIATION_FAILED` (0x15) removed | §3.5 | cleanup | `SESSION_ERROR` |
| PUBLISH may carry initial subscription parameters; PUBLISH_OK carries none; the subscriber changes them via REQUEST_UPDATE | §10.11, §10.20.1 | semantic | incoming-PUBLISH `accept(parameters)` path |
| REDIRECT: Retry Interval 0 means "do not retry as sent", following the redirect is still allowed | §10.6.2 | semantic | unchanged (REDIRECT treated as permanent) |
| OBJECT_DELIVERY_TIMEOUT starts at the last header byte | §12.2 | semantic | publisher-side timers only |
| Track Alias reuse guidance for publishers | §11.1 | semantic | review `duplicate track alias` fatal and `#waitForAlias` |

### LOCATION_FILTER field rules (§5.1.2)

```
LOCATION_FILTER Parameter {
  Parameter Type (vi64) = 0x21,
  Length (vi64),
  [StartGroup (vi64),]
  [StartObject (vi64),]
  [EndGroupDelta (vi64),]
  [EndObject (vi64),]
}
```

- Length 0: no filter (used in REQUEST_UPDATE to clear).
- 1 field: relative. Start = `{Largest.Group + 1 − StartGroup, 0}`. `0` = Next
  Group, `1` = start of the current group, `N` = N−1 groups before it. Clamped
  to `[0, 2^64−1]`.
- 2 fields: absolute start. `{0,0}` means **Next Object** (the old
  Largest Object filter), not "from the beginning" — an unfiltered request
  omits the parameter entirely.
- 3 fields: absolute start plus `EndGroupDelta` (end group is absolute
  `StartGroup + EndGroupDelta`, whole end group included; overflow is a
  PROTOCOL_VIOLATION).
- 4 fields: plus `EndObject`.
- Subscriptions with no end are open-ended; fetches with no end stop at
  Largest Object.

Mapping from today's `LocationFilter` union: `largest-object` → 2 fields
`{0,0}`; `next-group-start` → 1 field `0`; `absolute-start` → 2 fields;
`absolute-range` → 3 fields. Playback only uses the first two
(`track-subscriber.ts`, `subscribe-selected-tracks.ts`, `resolve-catalog.ts`).

### FILL_PARAMETERS (§10.2.15), for reference

Length-prefixed; value is `Number of Parameters (vi64)` + delta-typed
parameters. Allowed inside: FILL_TIMEOUT 0x0A, SUBSCRIBER_PRIORITY 0x20,
LOCATION_FILTER 0x21, GROUP_ORDER 0x22, range filters 0x25–0x28; anything
else is PROTOCOL_VIOLATION. Not sticky. Omitted inner parameters inherit the
subscription's. The publisher answers on a uni stream beginning with
`FETCH_HEADER` whose Request ID is the SUBSCRIBE's (or the REQUEST_UPDATE's);
no FETCH_OK; failure is a RESET; an empty range opens nothing. MSF-01's
"SUBSCRIBE with a Joining FETCH (offset 0)" (msf-01 §5) becomes, in spec
terms, a Next Object subscription plus a `StartGroup=1` fill (§5.1.6).

We do not need fills for the relay path (next section), so requesting them
is deferred work.

## What moq-relay 0.14.14 does (moq-dev/moq PR #3255)

Verified against `rs/moq-net/src/ietf/{filter,subscribe,fetch,parameters,
publisher,subscriber}.rs` and `js/net/src/ietf/{filter,parameters}.ts` on
`main` at 2026-09-02.

- **Negotiation.** Server accepts `moqt-20` through `moqt-14` plus the moq-lite
  ALPNs and picks by the client's offered ALPN. moq-dev's JS client offers a
  list and reads the negotiated value from `session.protocol` (cast around a
  missing type; Chrome exposes it).
- **LOCATION_FILTER** is encoded per the spec rules above. An open-ended
  absolute `{0,0}` is normalized to "omit the parameter".
- **Filters are honored to the object on draft-20.** `Next Object` starts at
  `{Largest.Group, Largest.Object + 1}` — the already-published head of the
  current group is **no longer replayed**. `Relative(N)` is served from the
  group cache: `Relative(1)` replays the current group from object 0 then
  continues live, on the ordinary subgroup stream. `Unfiltered` behaves like
  moq-lite (start of the latest group). On draft-19 and earlier the relay keeps
  its old behavior (whole current group replayed for Next Object; absolute
  filters ignored).
- **The relay's own subscriber joins upstream publishers with `Relative(1)`**
  and no fill, and refuses any fetch stream it did not ask for.
- **Fills are served, single-group only.** A `FILL_PARAMETERS` whose range
  resolves to one group is served from the cache as a real fetch stream
  (`FETCH_HEADER` + objects with absolute first IDs and timestamp properties +
  FIN). Multi-group or range-filtered fills open the stream and reset it. An
  omitted inner LOCATION_FILTER inherits the subscription's, so `Next Object`
  + fill-without-filter is an empty fill. `LARGEST_OBJECT` is sent in
  SUBSCRIBE_OK on draft-20 once the track has content.
- **FETCH is still decoded in the draft-19 shape on every version** (the PR
  did not touch `fetch.rs`). Only `RelativeJoining` with offset 0 is
  "accepted", and the response is FETCH_OK/REQUEST_OK plus an **empty** fetch
  stream (`FETCH_HEADER`, FIN). Standalone and absolute-joining are rejected.
  A spec-shaped draft-20 FETCH would be misparsed. **Never send FETCH to the
  relay on draft-20.** (This also means our current catalog joining FETCH has
  never returned data from this relay; the catalog resolves today only because
  the relay replays the current group for Next Object subscriptions on
  draft-19.)
- **SUBSCRIBE parameters accepted:** 0x02, 0x04, 0x06, 0x10, 0x20, 0x21, 0x22,
  0x23, 0x35. Any other parameter closes the session — including
  AUTHORIZATION_TOKEN (0x03), so the URL-token-only auth rule still holds.
  REQUEST_UPDATE accepts 0x02, 0x06, 0x10, 0x20, 0x21, 0x23. `forward: 0` is
  rejected.
- **`LARGEST_OBJECT` (0x09) is framed length-prefixed** — a varint length then
  two varints — on every draft, and its decoder requires that framing. The
  spec text (§10.2) says a Location parameter is two bare varints. moq-dev
  argues odd parameter types get a length by the Key-Value-Pair parity rule
  and lists this as a spec conflict. Because the relay only sends it on
  draft-20, our draft-19 sessions are unaffected today; on draft-20 our bare
  decode would desync the parameter list and kill every SUBSCRIBE_OK with
  content.
- **`INCLUDE_PROPERTIES` (0x35) is framed length-prefixed with a single byte
  inside**, again by parity, although §10.2.21 calls it a uint8. The relay
  obeys it as a publisher and sends it only to opt out (which its upstream
  subscriber does not do today).
- Range filters 0x26/0x28 are length-prefixed (matches the spec's explicit
  Length field and our codec).
- Draft-20 PUBLISH_OK (REQUEST_OK) carries no parameters.
- PUBLISH_DONE Stream Count is always 0.
- **Subgroup streams are checked against the Object ID:** the first object's
  delta must be its absolute ID and later deltas must be contiguous. A stream
  that starts partway through a group, or has a gap, is dropped per-stream.
- Not implemented by the relay: PUBLISH_STATE_NOTIFY, requesting fills as a
  subscriber, multi-group fills.

## Consequences for our engine

1. **Catalog join must change or the catalog stops resolving.** Today
   `resolve-catalog.ts` subscribes with `largest-object` and issues a
   relative-joining FETCH (offset 0); the FETCH returns nothing, and the
   independent catalog object arrives because the relay replays the current
   group. On draft-20 a Next Object subscription delivers deltas only, which
   the resolver drops until the next independent object. Join with
   `Relative(1)` instead: the relay serves the current group from object 0 on
   the subscription stream, then live. No FETCH at all. The live-object
   buffering and settle timer that exist to order fetch replay against live
   deltas are unnecessary on this path.
2. **Audio (`largest-object`) starts at the live edge instead of the current
   group's start.** Correct for audio (every frame decodable) and less
   pre-roll, but `joinAnchorUs` in `media/moq/timeline.ts` documents the old
   replay assumption; verify `sync-latency` / `adapt-latency-target` converge
   with a shorter initial buffer.
3. **Video (`next-group-start` → `Relative(0)`) and switch handoffs are
   unchanged.** Optional improvement: join video with `Relative(1)` for an
   instant, decodable start; the renderer already fast-forwards a backlog
   behind the edge.
4. **`LARGEST_OBJECT` decode must be length-prefixed on draft-20** or the
   session dies on the first SUBSCRIBE_OK with content. Use the relay's framing
   on every draft (we never send it as a subscriber; nothing else sends it on
   19) and cite the conflict in the codec comment.
5. **Fills are not needed** for playback against the relay. Decode
   `FILL_PARAMETERS` and `INCLUDE_PROPERTIES` so a peer sending them does not
   kill a session (the publisher branch receives SUBSCRIBE), but requesting
   fills and routing fill streams is deferred.
6. **FETCH stays draft-19-only** in practice: keep the joining FETCH on the 19
   path, send none on 20. Implement the spec-shaped draft-20 encoder/decoder
   for completeness and tests, not for the relay.
7. **Publisher branch:** the relay will subscribe upstream with `Relative(1)`.
   If the publisher only delivers from the next object, the relay drops that
   mid-group stream and the join degrades to the next group boundary. Serving
   the current group from object 0 (retaining the in-progress group's frames)
   restores the instant join. The publisher must also send `LARGEST_OBJECT`
   (length-prefixed) in SUBSCRIBE_OK on draft-20 (spec MUST once content
   exists; the relay decodes it that way) and accept 0x23/0x35 on inbound
   SUBSCRIBE.

## Rollout

The whole fleet speaks `moqt-20`, so a hard cutover is viable and is the
smaller change. Offering `['moqt-20', 'moqt-19']` and reading the negotiated
`transport.protocol`, the way moq-dev's JS client does, is worth it only if
third-party relays (Varnish lab, other draft-19 deployments) must keep
working during the transition; it costs the five branch points below and a
second test matrix. Decide before Phase 1; the codec work is the same either
way, the difference is whether the 19 paths are deleted or kept behind a
switch.

**Decision (2026-09-02): cut over.** `feat/moq-transport-20` (off `mmcc/moq`)
speaks `moqt-20` only and deletes the draft-19 filter tags, Fetch Type
structures, and the catalog joining FETCH. The five branch points below are
kept as the list of what changes, not as runtime switches.

Branch points on a `draft: 19 | 20` value in `createMoqtSession` config:

1. LOCATION_FILTER encode/decode (tag form vs field list).
2. FETCH body shape (only sent on 19).
3. Catalog join: `largest-object` + joining FETCH (19) vs `Relative(1)`, no
   FETCH (20).
4. Whether to expect `LARGEST_OBJECT` in SUBSCRIBE_OK (informational; framing
   is the same on both).
5. Whether `FILL_PARAMETERS` / `INCLUDE_PROPERTIES` are legal on inbound
   messages (publisher branch; the relay rejects them on 19 and so should we).

## Work items

### Phase 1 — codec (`packages/spf/src/network/moqt/`)

`control-messages.ts`

- Export `MOQT_PROTOCOL_IDS = ['moqt-20', 'moqt-19']`, a `MoqtDraft` type, and
  a lookup from negotiated protocol string to draft.
- `MESSAGE_TYPE`: add `PUBLISH_STATE_NOTIFY: 0x22`.
- `PARAMETER_TYPE`: add `FILL_PARAMETERS: 0x23`, `INCLUDE_PROPERTIES: 0x35`.
- `REQUEST_ERROR_CODE`: drop `INVALID_JOINING_REQUEST_ID` and its entry in
  `PERMANENT_REQUEST_ERROR_CODES`.
- `PUBLISH_DONE_STATUS`: drop `SUBSCRIPTION_ENDED`.
- `LocationFilter`: new union — `{ type: 'next-object' }`,
  `{ type: 'relative-group'; groupsBeforeNext: number }`,
  `{ type: 'absolute'; start: Location; endGroupDelta?: number; endObject?: number }`.
  Encoder normalizes open-ended absolute `{0,0}` to "omit the parameter" (as
  the relay does). Draft-19 tag form: `next-object` → 0x2, `relative-group 0`
  → 0x1, `relative-group N>0` → throw (no tag can express it), `absolute` →
  0x3/0x4, `endObject` → throw on 19.
- `LARGEST_OBJECT`: encode and decode as length-prefixed `{group, object}`
  varints on every draft; comment cites the §10.2 conflict and PR #3255.
- `MessageParameters`: add `fillParameters?: MessageParameters` (nested
  `encodeMessageParameters`; decoder enforces the allow-list and rejects it on
  draft-19) and `includeProperties?: 0 | 1` (length-prefixed single byte;
  reject values other than 0/1; reject on draft-19).
- `FetchRequest` on 20 collapses to `{ requestId, trackNamespace, trackName,
  parameters }` with the range in `parameters.locationFilter`; the 19 shapes
  stay behind the draft switch.
- `ControlMessage`: add `{ kind: 'publish-state-notify'; parameters }`.
- Re-cite every `§10.x` ≥ 10.10 in comments (32 citations in this file; 12 in
  `session.ts`, 6 in `object-stream.ts`, 6 in `resolve-catalog.ts`).

`errors.ts`: drop `VERSION_NEGOTIATION_FAILED`.

`object-stream.ts`: add `FETCH_END_OF_TIMED_OUT_RANGE = 0x20c` →
`status: 'timed-out'`; update Type Flags comments (behavior already matches).

Tests: golden vectors for each LOCATION_FILTER field count and the
`{0,0}`-omission rule; length-prefixed LARGEST_OBJECT byte-pinned against
moq-dev's vector `[0x01, 0x09, 0x04, 0x80, 0xff, 0x80, 0x80]` for
`{255, 128}`; INCLUDE_PROPERTIES framing and range check; FILL_PARAMETERS
nesting and allow-list violation; draft-20 FETCH round-trip;
PUBLISH_STATE_NOTIFY decode; 0x20C entries.

### Phase 2 — session driver (`session.ts`)

- `MoqtSessionConfig.draft`; `MoqtFetchOptions` gains the draft-20 shape.
- `#handleSubscriptionMessage`: accept `'publish-state-notify'` →
  `onStateNotify?(parameters)`, no reply; fatal on fetch and track-status
  streams (§10.10).
- `Subscription.update()` allocates a fresh Request ID (§10.1; see
  pre-existing bugs).
- PUBLISH_DONE Stream Count: saturating read so the 2^64−1 sentinel does not
  kill the session (the relay sends 0, so low urgency).
- Fill-stream routing (FETCH_HEADER carrying a SUBSCRIBE or REQUEST_UPDATE
  Request ID): deferred to Phase 6; until then an unexpected fetch stream for a
  subscription id is cancelled, not fatal.
- Tests: PUBLISH_STATE_NOTIFY on a subscription vs a fetch stream;
  REQUEST_UPDATE id uniqueness; length-prefixed LARGEST_OBJECT in SUBSCRIBE_OK
  reaches `onOk`.

### Phase 3 — playback (`packages/spf/src/playback/`)

- `behaviors/resolve-catalog.ts`: on draft-20 subscribe with
  `{ type: 'relative-group', groupsBeforeNext: 1 }` and issue no FETCH; apply
  objects directly (they arrive in order on one stream). Keep the 19 path
  (`largest-object` + joining FETCH + settle buffering) behind the switch and
  delete it with the 19 branches. Recovery restarts keep the same filter.
- `actors/track-subscriber.ts`, `behaviors/subscribe-selected-tracks.ts`:
  rename literals (`largest-object` → `next-object`, `next-group-start` →
  `relative-group 0`). Decide whether video's initial join moves to
  `relative-group 1`.
- Verify the audio join: with no current-group replay the first buffered
  frame is the live edge; check `joinAnchorUs` callers and the latency
  controller's initial depth.
- `actors/moq-session.ts`: offer both protocols, read `transport.protocol`
  (cast, as moq-dev does), surface the draft on the session context and pass
  it to `createMoqtSession`; refresh the draft-19 auth comments.
- Tests: `resolve-catalog.test.ts` (8 joining-fetch expectations become
  draft-19-only; add the draft-20 direct-apply path), `engine.test.ts`,
  `moq-session.test.ts`, `track-subscriber.test.ts`,
  `subscribe-selected-tracks.test.ts` filter literals.

### Phase 4 — sandbox templates and prose

- `apps/sandbox/templates/spf-moq-player/loopback-relay.ts` (and the
  publisher branch's `moq-publisher/loopback-relay.ts`): both hand-roll
  draft-19 SETUP / SUBSCRIBE / SUBSCRIBE_OK / FETCH-reject and already replay
  the newest buffered group. Under 20: parse the field-list LOCATION_FILTER,
  replay the current group only for `Relative(≥1)` (mirror the relay's strict
  Next Object), tolerate 0x23/0x35, send length-prefixed LARGEST_OBJECT, and
  drop the FETCH branch. Update the `moqt-19` / draft-19 comments in
  `spf-moq-player/main.ts`, `index.html`, `moq-relay-interop/main.ts`,
  `adapt-latency-target.ts`, and the `moq-session.ts` header.
- `moq-relay-interop/main.ts`: its `relay.mux.dev` default is on 0.14.14, so
  it doubles as the draft-20 smoke test once the header comment and expected
  `serverImplementation` are refreshed.

### Phase 5 — publisher branch (`mmcc/moq-publisher`)

`packages/spf/src/publish/session/publish-session.ts` is a second session
driver on the shared codec, so Phase 1 lands the decode. Publisher-specific:

- Serve `Relative(1)` (and `Relative(0)`, `Next Object`) per the draft-20
  rules: retain the in-progress group's frames in `track-publisher.ts` so a
  `Relative(1)` subscriber gets the group from object 0 with contiguous IDs
  (the relay drops a stream that starts partway through). Without this the
  relay's upstream join degrades to the next group.
- Send `LARGEST_OBJECT` (length-prefixed) in SUBSCRIBE_OK on draft-20 once
  the track has content.
- Inbound `FILL_PARAMETERS`: honest minimum is open-and-reset (§5.1.3.1); the
  relay never sends one today.
- Inbound FETCH decode shape follows the draft; keep rejecting.
- REQUEST_UPDATE now consumes its own Request ID: the "every inbound request
  ID ever seen" check must accept it as a new id.
- `subgroup-writer.ts` / `track-publisher.ts`: numbering from 0 without gaps
  already satisfies the relay's check; comment updates only.
- Optional: PUBLISH_STATE_NOTIFY with LARGEST_OBJECT on capture-source
  switches (the relay ignores it today).

### Phase 6 — deferred: fills as a subscriber

Route FETCH_HEADER streams by SUBSCRIBE / REQUEST_UPDATE Request ID to
`onFillEntry` / `onFillEnd` / `onFillReset` on the subscription, request
`FILL_PARAMETERS` with `Relative(1)` for a spec-canonical exactly-once join,
and decode End of Timed-Out Range into the fill path. Only worth doing when a
strict publisher (one that does not replay `Relative(1)` from cache) matters.

## Pre-existing bugs this pass surfaced

1. **REQUEST_UPDATE reuses the subscription's Request ID.**
   `Subscription.update()` calls `encodeRequestUpdate(requestId, …)` with the
   SUBSCRIBE's id. §10.1 (unchanged since draft-19) lists REQUEST_UPDATE
   among the messages that consume a Request ID, and a duplicate id MUST close
   the session with INVALID_REQUEST_ID. Latent today (no playback caller
   sends REQUEST_UPDATE).
2. **PUBLISH_DONE Stream Count sentinel is undecodable.** 2^62−1 (draft-19)
   and 2^64−1 (draft-20) both exceed `MAX_VARINT_VALUE` (2^53−1), so
   `decodeVarint` throws and the session dies on a legitimate PUBLISH_DONE.
   The relay sends 0, so this is dormant against the fleet.
3. **The catalog join depends on non-conformant relay behavior.** Our joining
   FETCH has never returned data from moq-relay; the catalog resolves because
   draft-19 relays replay the current group for Next Object subscriptions.
   Draft-20 removes that replay, which is why item 1 under Consequences is
   mandatory, not a cleanup.

## Open questions

- Confirm `WebTransport.protocol` is populated in the Chrome builds the
  sandbox targets (moq-dev's JS relies on it with a cast). Fallback: a URL flag
  selecting a single offered protocol.
- Video initial join: keep `Relative(0)` (wait for the next group, no
  fast-forward) or move to `Relative(1)` (instant, decoder catches up)? Both
  are served by the relay; this is a latency/CPU trade the sandbox can
  measure.
- MSF-01 still mandates a Joining FETCH for the catalog; track the msf
  revision so the `Relative(1)` join stays defensible against other relays.
- FETCH_OK End Location inclusivity only matters if Phase 6 or a real FETCH
  path lands.

## Estimated size

Codec ≈ 350 lines changed, session ≈ 100, playback ≈ 150, tests ≈ 300 across
six files, each sandbox loopback ≈ 120, publisher session + track-publisher
≈ 200. Two PRs: codec + session + playback + player sandbox on `mmcc/moq`, then
the publisher follow-up on `mmcc/moq-publisher` after rebasing onto it.
