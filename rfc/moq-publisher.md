---
status: draft
---

# MoQ Publisher

Add the publish direction to Video.js: camera/microphone/screen capture → WebCodecs encode → Media over QUIC (MOQT) publish to a relay, exposed as a composable publisher preset that shares the player architecture — feature slices over one store, capability-gated media contracts, custom elements plus React components, and the existing skins and themes.

## Problem

Video.js 10 plays MoQ streams (the subscribe-side engine, `@videojs/spf/moq`, and `<simple-moq-video>`), but every publisher UI today is bespoke: apps hand-roll capture, encoding, transport, and controls with no shared contracts, theming, or accessibility. Live products need both halves; shipping only playback pushes integrators to a second, inconsistent stack for ingest.

The publisher must feel like Video.js: composable features rather than a monolithic widget, controls that degrade when a capability is absent, and skins that inherit the same theme tokens.

## Customer salience

Interactive-live products (creator streaming, auctions, watch parties) publish from the browser and want sub-second glass-to-glass, which is MoQ's core promise. A first-party publisher that pairs with the existing MoQ player makes Video.js a complete low-latency loop rather than half of one.

## Options considered

- **Wrap an existing MoQ library (`@kixelated/moq`)** — fastest to working video, but adds a runtime dependency (the repo ships zero for SPF beyond `signal-polyfill`) and pins us to moq-lite, which has diverged from the IETF drafts our relays and playback engine speak. Reversible, but the API would leak.
- **Implement publish in-repo on the existing MOQT stack (recommended)** — the subscribe side already implements draft-19 framing, control messages, object streams, and a session driver in `packages/spf/src/network/moqt/`; MSF catalog parsing and LOC extraction live in `packages/spf/src/media/moq/`. Publishing is the complementary direction of each module: encode the messages we currently decode, write the streams we currently read, build the catalog we currently parse.
- **Separate publisher architecture (own store/factory/elements)** — rejected; the publisher host is a `Media` (its local preview is a real `<video>`), so the player's provider/store/feature machinery applies unchanged, and a parallel stack would duplicate all of it.

## Recommendation

The recommended option is now implemented as a v1 vertical slice in the working tree; the bullets below describe what landed. Registry detail lives in [internal/design/spf/features/moq-publish.md](../internal/design/spf/features/moq-publish.md) and [internal/design/spf/use-cases/moq-live-publish.md](../internal/design/spf/use-cases/moq-live-publish.md).

- **Contracts**: capability interfaces in `@videojs/media` core — `MediaPublishCapability` (`publishState`, `publish()`/`unpublish()`), `MediaCaptureSourceCapability` (camera/screen acquire/switch/release with permission-derived `captureState`), `MediaCaptureDevicesCapability`, `MediaCaptureToggleCapability`, `MediaPublishStatsCapability` — each with an `isMedia*Capable` predicate so player features no-op on non-publisher media and publisher features no-op on players. The DOM host is `MoqPublishMedia` (`packages/media/src/dom/moq-publish/`).
- **Engine**: a new `publish/` SPF layer (peer of `playback/`) — `createMoqPublishEngine`, exported as `@videojs/spf/moq-publish` — composing behaviors over signals: acquire capture → preview via `srcObject` → WebCodecs encoders (actor-owned, keyframe-aligned so GoP = MoQ group) → LOC packaging → MOQT publish session with an MSF catalog track. Protocol pins match the playback stack: **moq-transport draft-19, MSF catalog, LOC packaging**. Config seams: `connectTransport`, `buildCatalog`, `chunkSink`, `selectEncoderConfig` (default `avc1.42E01F` with `vp8` fallback + Opus), `groupDurationSec`, `maxEncodeQueueSize`, `maxQueuedGroups`, `statsIntervalMs`, `requestTimeoutMs`.
- **Surface**: the `publisherFeatures` preset (`@videojs/core`), `<video-publisher>` provider + `<publisher-skin>`, `<moq-publish-video>`, and the publisher `media-*` controls (publish button, camera/mic mutes and device menus, screen share, badge/timer, connection indicator, capture placeholder) on the standard three-layer component pattern, reusing `--media-*` theme tokens so existing themes apply unchanged.
- **Scope (v1)**: single video rendition + Opus audio; camera + mic + screen share; Chromium-only (`MediaStreamTrackProcessor`, WebTransport); no FETCH serving, datagrams, subscribe filters, catalog deltas, reconnect, or simulcast — the track/actor model leaves simulcast additive (`config.video` as an array is the seam).
- **Verification**: publish-direction codecs round-trip against the existing subscribe-side decoders (`publish-direction`, `subgroup-writer`, `loc-packaging`, `build-catalog` tests); a full-pipeline test drives real capture + WebCodecs through the publish session into the existing subscribe driver over an in-memory transport pair; the sandbox `moq-publisher` template pairs the skinned publisher with `<simple-moq-video>` over an in-page loopback relay — camera in, playback out, one page — with a `?real` mode against an actual relay.

### What implementing settled

- **No new wire codecs.** The parent MoQ branch's draft-19 control-message codec was already symmetric; the publish direction added only sibling modules — `network/moqt/subgroup-writer.ts` (the write complement of the object-stream reader) and `media/moq/{loc-packaging,build-catalog}.ts` (the encode complements of `loc.ts` / `parse-catalog.ts`, round-trip-tested against them).
- **Flow choice.** Publisher-initiated PUBLISH per track (catalog/video/audio) is the primary flow; PUBLISH_NAMESPACE is sent first as an advisory announce whose rejection is surfaced but never fatal. Inbound SUBSCRIBEs on published tracks are answered (relays subscribe to pull data toward demand); GOAWAY drains the session; PUBLISH_DONE ends each track.
- **Layer placement.** The publish session driver lives in `publish/session/` rather than `network/moqt/`, keeping the parent-owned wire layer strictly additive; it mirrors the subscribe driver's callback shape (no signals) with signal awareness entering at the behavior layer.
- **Backpressure is two-staged.** The encoder actor drops delta frames on codec queue depth (keyframes never drop, so groups stay decodable); the track publisher aborts stale groups past `maxQueuedGroups` and resumes at the boundary keyframe.

## Final decision

Pending review. The v1 vertical slice is implemented behind this draft — see the publish engine in `packages/spf/src/publish/`, the media contracts in `packages/media/src/core/`, and the registry records: [feature](../internal/design/spf/features/moq-publish.md) and [use case](../internal/design/spf/use-cases/moq-live-publish.md).
