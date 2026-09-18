# Publish a stream for the MoQ player

Publish an MSF catalog and LOC audio/video tracks to play a live stream with Video.js 10's experimental MoQ engine. This guide describes the subscriber implemented in this checkout. It covers one selected video source and one audio track, including automatic bitrate selection (ABR) among video renditions.

## Match the protocol versions

Your publisher and relay must serve the versions the subscriber speaks:

| Layer | Version | What to serve |
| --- | --- | --- |
| Transport | `draft-ietf-moq-transport-20`, protocol ID `moqt-20` | MOQT over WebTransport |
| Catalog | `draft-ietf-moq-msf-01` | UTF-8 JSON on a catalog track |
| Media | `draft-ietf-moq-loc-04` | One encoded audio or video chunk per MOQT object |

The [vendored specifications](../../../internal/specs/moq/README.md) contain the pinned drafts. A relay accepting WebTransport does not by itself establish compatibility with this catalog and media format.

Playback requires a browser with WebTransport, WebCodecs video and audio decoders for your chosen codecs, and Web Audio. A browser-based publisher also needs the corresponding encoders. Check the actual decoder configurations with `VideoDecoder.isConfigSupported()` and `AudioDecoder.isConfigSupported()` on your target browsers.

## Choose the catalog address

For a relay endpoint at `https://relay.example.com/live`, publish the catalog as track `catalog` in namespace tuple `["demo", "alice"]`. Give the player this source:

```text
moqt://relay.example.com/live#msf:demo-alice--catalog
```

The fragment identifies the namespace and track; the WebTransport connection uses the HTTPS endpoint without the fragment. This example uses simple namespace components. For names containing separator characters, use the encoding implemented by [`encodeNamespaceName`](../src/media/moq/parse-source.ts).

Media entries that omit `namespace` inherit the catalog namespace. In this example, `camera-720p` therefore addresses `["demo", "alice"]` plus track name `camera-720p`. Explicit catalog namespaces are slash-separated strings, such as `"demo/alice"`. Keep each full track name unique and stable across catalog updates.

## Advertise video sources and quality renditions

Publish this complete catalog as object 0 of a catalog group. Encode the advertised media separately on the four named tracks; the JSON describes those tracks and contains no media bytes.

```json
{
  "version": "draft-01",
  "tracks": [
    {
      "name": "camera-360p",
      "label": "Camera",
      "packaging": "loc",
      "isLive": true,
      "role": "video",
      "altGroup": 1,
      "renderGroup": 1,
      "codec": "vp8",
      "width": 640,
      "height": 360,
      "framerate": 30,
      "bitrate": 600000,
      "timescale": 1000000,
      "targetLatency": 500
    },
    {
      "name": "camera-720p",
      "label": "Camera",
      "packaging": "loc",
      "isLive": true,
      "role": "video",
      "altGroup": 1,
      "renderGroup": 1,
      "codec": "vp8",
      "width": 1280,
      "height": 720,
      "framerate": 30,
      "bitrate": 2400000,
      "timescale": 1000000,
      "targetLatency": 500
    },
    {
      "name": "screen",
      "label": "Screen share",
      "packaging": "loc",
      "isLive": true,
      "role": "video",
      "altGroup": 2,
      "renderGroup": 1,
      "codec": "vp8",
      "width": 1920,
      "height": 1080,
      "framerate": 15,
      "bitrate": 1200000,
      "timescale": 1000000,
      "targetLatency": 500
    },
    {
      "name": "audio",
      "label": "Microphone",
      "packaging": "loc",
      "isLive": true,
      "role": "audio",
      "renderGroup": 1,
      "codec": "opus",
      "samplerate": 48000,
      "channelConfig": "2",
      "bitrate": 64000,
      "timescale": 1000000,
      "targetLatency": 500
    }
  ]
}
```

Use the actual codec, dimensions, frame rate, audio layout, and bitrates you encode. `bitrate` is in bits per second; `targetLatency` is in milliseconds and supplies a player default that the application can override. The example's 500 ms is a starting point, not a delivery guarantee.

The grouping fields have different jobs:

- **`altGroup` identifies alternatives of the same content.** Both camera encodes use `1`, so ABR can switch between them. Screen share uses `2`, so a bandwidth change cannot substitute it for the camera. If screen share gains another resolution, give that rendition `altGroup: 2` too. Group numbers are catalog-scoped, including across namespaces.
- **An ungrouped video track is its own content source.** Omitting `altGroup` from every rendition prevents automatic adaptation between them. Omitting it from a standalone screen track is valid.
- **`renderGroup` identifies accompanying tracks.** It does not establish quality alternatives. The current player still renders only one video source and one audio track; it does not compose camera and screen into a layout or choose accompanying audio based on this field.

Put the default video source first in catalog order. Here, the player initially selects within the camera ladder. Keep `role: "video"` for screen share too; `"screen"` is a track name, not a supported video role. Include readable labels for consumers, but the current video presentation projection does not retain them.

## Encode independently decodable media

VP8 video and Opus audio are used by the [loopback publisher](../../../apps/sandbox/templates/spf-moq-player/loopback-relay.ts). Other codecs depend on WebCodecs support and matching decoder initialization. The engine forwards catalog codec strings into decoder configurations; it does not transcode media.

For each video rendition:

1. Put exactly one encoded video chunk's bytes in each MOQT object payload. With `packaging: "loc"`, send the elementary chunk bytes expected by WebCodecs, not MP4 segments, WebM containers, or JSON-wrapped frames.
2. Start each group at object ID 0 with a keyframe. Put subsequent frames from that group of pictures in increasing object IDs in the same group. Start a new group at the next keyframe. The subscriber derives the video keyframe flag from `objectId === 0`.
3. Use a shared capture timeline for camera renditions, screen share, and audio. With `timescale: 1000000`, timestamps are microseconds. Do not restart an encoder's timestamps at zero when a viewer subscribes or screen share starts.
4. Align keyframes and group numbering across renditions sharing an `altGroup`. Equally numbered groups should start at overlapping presentation times, as specified by MSF §4.2. Publish independently decodable renditions; advertising `depends` does not cause this subscriber to fetch dependency layers.

Put the LOC `TIMESTAMP` property (`0x10`) on every media object. Missing timestamps cause frames to be discarded. If your wire timestamps use another unit, declare a positive `TIMESCALE` (`0x08`) in the object or subscription's Track Properties. The subscriber resolves units in this order: object property, subscription Track Properties, catalog `timescale`, then microseconds. A relay that rescales timestamps must declare the units it actually delivers.

Each audio object likewise carries one encoded audio chunk and its timestamp. Publish audio continuously on the shared timeline, with object numbering starting at zero in each audio group. The example uses 48 kHz stereo Opus. Declare the actual `samplerate` and `channelConfig`; non-Opus audio needs an explicit sample rate. Use a numeric channel-count string such as `"1"` or `"2"` for straightforward layouts.

For codecs requiring decoder initialization bytes, add an inline `initDataList` entry at the catalog root with `id`, `type: "inline"`, and base64 `data`, then reference its ID from the track's `initRef`. These bytes become WebCodecs `description`. Video can also carry updated decoder configuration in the LOC Video Config property (`0x0d`) on a keyframe. Audio initialization comes from the catalog; this reader does not consume the LOC Audio Config property.

Keep a ladder within one codec family for this implementation. Its shared selection rules retain the selected codec family; a catalog containing multiple families is not a promise of switching between them.

## Serve late joins and track changes

The catalog subscription requests the current group from its start (`relative-group 1`). Your relay must make that group's full catalog and subsequent deltas available to a new subscriber. Object 0 holds an independent catalog; later objects in the same group hold deltas. Put each new independent catalog at object 0 of a new group. A delta arriving without its group's independent catalog is ignored.

Initial video joins and track switches request the next group (`relative-group 0`). Publish keyframes regularly so joins and switches do not wait indefinitely. Initial audio joins request the next object. During a switch, the player keeps the old subscription until the replacement has a decodable group whose first buffered frame is due on the playback clock. Budget for a short overlap in delivery.

When screen share ends, publish this delta as the next object in the current catalog group:

```json
{
  "deltaUpdate": [
    {
      "op": "remove",
      "tracks": [{ "name": "screen" }]
    }
  ]
}
```

When it returns, publish an `add` delta containing its complete track entry from the catalog above, or publish a new independent catalog in a new group. Keep the namespace, names, and alternate groups of unchanged tracks stable. A subscription ending by itself does not remove a catalog entry: the subscriber can retry it, expecting the publisher to return.

## Verify with the current player

Run `pnpm dev:sandbox` and open `/spf-moq-player/`. Paste your full `moqt://…#msf:…` URL into the relay input. If you use the page's `?relay=` query parameter instead, percent-encode the source URL so its `#` remains part of the parameter.

Check that both camera renditions appear, manual quality selection changes the media subscription, and Auto resumes adaptation within the camera group. Verify audio/video synchronization, late joins, and catalog updates after screen share starts or stops.

The current sandbox lists only the first video group's rendition buttons, and `<simple-moq-video>` does not expose public `videoTracks` / `videoRenditions` lists yet. A separate screen track can be present in the resolved catalog without appearing in those controls. An engine-level diagnostic can select its exact track ID:

```ts
// `media` is the mounted SimpleMoqVideoElement.
const presentation = media.engine.state.presentation.get();
const videos = presentation?.selectionSets?.find((set) => set.type === 'video');
const tracks = videos?.switchingSets.flatMap((set) => set.tracks) ?? [];
const screen = tracks.find((track) => track.id === 'demo/alice/screen');

if (screen) media.engine.state.userVideoTrackSelection.set({ id: screen.id });
```

This pins that rendition. Clearing `userVideoTrackSelection` resumes ABR within the currently selected content group. It does not select the default camera again. Track IDs derive from the full namespace and name; inspect the presentation's IDs when using names with escaped characters.

The loopback is useful for frame and wire examples, but its current catalog omits `altGroup` on `video-hi` and `video-lo`. Those tracks are therefore separate content groups. Use the catalog above as the grouping example for an ABR ladder.

This playback path is live-only LOC audio/video. It does not provide simultaneous camera/screen rendering, dependency-layer subscriptions, text rendering, CMSF media, encrypted-media playback, or DVR seeking.

## Implementation references

- [Catalog parsing and grouping](../src/media/moq/parse-catalog.ts) and [camera/screen catalog tests](../src/media/moq/tests/parse-catalog.test.ts)
- [LOC frame extraction](../src/media/moq/loc.ts) and [decoder configuration](../src/media/moq/codec-mapping.ts)
- [Catalog subscription and updates](../src/playback/behaviors/resolve-catalog.ts)
- [Track selection](../src/playback/behaviors/track-switching.ts) and [subscription handoff](../src/playback/behaviors/subscribe-selected-tracks.ts)
