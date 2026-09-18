import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';
import { createSubscriber, makeSyntheticStream } from './helpers/cross-engine-harness';

/**
 * Cross-engine regression suite: the real publish engine (DEFAULT encoder config — H.264 in `avc` (AVCC) bitstream
 * format, with the avcC published out-of-band as the catalog's `initDataList`; see `probe-encoder-support.ts` for the
 * carriage history) publishing through an in-memory draft-20 relay hub to the real playback engine rendering onto a
 * canvas.
 *
 * Covers the real-world publisher bugs: - a LATE-joining subscriber (after ≥1 group boundary) must reach decoded video
 * with the default codec config; - screen share starting ADDITIVELY mid-session — the whole point of the multi-source
 * redesign — must keep the session and the camera's served tracks alive (no track-ending subscribe-stream FIN, no
 * reconnect) while the new `screen` track arrives on the subscriber as its own content: a second video switching set,
 * never a quality alternate the ABR ranker may swap the camera for; - audio (the mic's own always-on pipeline) must
 * keep flowing to the subscriber throughout, unaffected by screen starting or stopping.
 *
 * Ingest is announce-and-serve (moq-relay 0.14.7): the session goes live on the ANNOUNCE, and a track publisher writes
 * nothing until the hub subscribes to that track — so the wire-level flow assertions prime standing upstream demand on
 * the hub first, standing in for the other viewers a real relay would be pulling for.
 */

const disposals: (() => void)[] = [];

const CAMERA_SIZE = { width: 320, height: 240 } as const;
const SCREEN_SIZE = { width: 480, height: 360 } as const;

/**
 * Stub capture: camera and mic each get their own video-only / audio-only stream (dispatched on which of
 * `video`/`audio` the constraints ask for — mirroring the two independent `getUserMedia` callers); screen share's
 * `getDisplayMedia` returns a different-resolution video-only stream.
 */
function installCaptureStubs(): void {
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints?: MediaStreamConstraints) => {
    if (constraints?.audio) return makeSyntheticStream(CAMERA_SIZE, true, disposals); // audio-only ask: the mic pipeline

    return makeSyntheticStream(CAMERA_SIZE, false, disposals); // video-only ask: the camera pipeline
  });
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia: (constraints?: unknown) => Promise<MediaStream>;
  };

  vi.spyOn(mediaDevices, 'getDisplayMedia').mockImplementation(async () =>
    makeSyntheticStream(SCREEN_SIZE, false, disposals)
  );
}

describe('publish engine ↔ playback engine (relay hub)', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('late join decodes default-config video, and screen share adds a second live track without disturbing camera', async () => {
    installCaptureStubs();
    const hub = createRelayHub();

    disposals.push(() => hub.destroy());

    // ── Publish (default codec config: avc1, avc format) ─────────────────
    const publisher = createMoqPublishEngine({
      groupDurationSec: 1,
      connectTransport: hub.connectPublisher,
    });

    disposals.push(() => void publisher.destroy());

    publisher.state.endpoint.set({ url: 'https://relay.test/moq', namespace: ['live'] });
    publisher.state.cameraActive.set(true);
    publisher.state.publishActivated.set(true);

    await vi.waitFor(() => expect(publisher.state.sessionStatus.get()).toBe('live'), { timeout: 10_000 });
    // The default ladder must have picked H.264 — the codec real-relay
    // interop runs on, and the one whose bitstream format choice decides
    // whether keyframes are self-describing.
    await vi.waitFor(() => {
      expect(publisher.state.activeEncodings.get()?.camera?.codec).toMatch(/^avc1/);
    });

    // ── Let ≥1 group boundary pass before the PLAYER subscribes ──────────
    // Pull-through ingest writes nothing unsubscribed: prime standing
    // upstream demand (other viewers, in the field) so a backlog exists
    // for the late joiner to land into.
    hub.subscribeUpstream('video');
    hub.subscribeUpstream('audio');
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(35); // > one full 1s group at 30fps
        expect(hub.objectCount('audio')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // ── Late join: the real playback engine, subscribed to the catalog ───
    const { canvas: renderCanvas, signals } = createSubscriber(hub, disposals);

    // Bug regression: the late joiner must reach decoded, PRESENTED video
    // from a post-join keyframe with the default codec config.
    await vi.waitFor(
      () => {
        const renderer = signals.context.videoRendererActor.get();

        expect(renderer?.snapshot.get().context.framesDecoded ?? 0).toBeGreaterThan(0);
        expect(renderer?.snapshot.get().context.lastPresentedTimestampUs).toBeDefined();
      },
      { timeout: 15_000, interval: 100 }
    );
    // The canvas took the camera stream's dimensions on present.
    expect(renderCanvas.width).toBe(CAMERA_SIZE.width);
    // Audio (the mic's own pipeline) is being scheduled from the live opus track.
    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()?.snapshot.get().context.framesScheduled ?? 0).toBeGreaterThan(
          0
        );
      },
      { timeout: 15_000, interval: 100 }
    );

    // ── Regression: screen share starts ADDITIVELY while subscribed ──────
    const audioObjectsBeforeScreen = hub.objectCount('audio');
    const cameraObjectsBeforeScreen = hub.objectCount('video');
    const trackEndsBeforeScreen = hub.trackEnds.length;
    const connectionsBeforeScreen = hub.publisherConnections();

    publisher.state.screenShareActive.set(true);
    // Demand for the new track (the hub retries until the publisher
    // registers it) — the viewer below only pulls screen when selected.
    hub.subscribeUpstream('screen');

    // The screen track is its own independent, non-alternate video track in
    // the catalog — it flows on the wire while the camera keeps flowing
    // untouched underneath (additive, not a swap).
    await vi.waitFor(
      () => {
        expect(hub.objectCount('screen')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // …and it reaches the subscriber as a SECOND video switching set. Both
    // tracks are `role: 'video'` in one `renderGroup` (render together), so
    // folding them into one set made the bandwidth ranker read the screen
    // share as a cheaper camera and swap the viewer's content on a dip.
    await vi.waitFor(
      () => {
        const videoSet = signals.state.presentation.get()?.selectionSets?.find((set) => set.type === 'video');

        expect(videoSet?.switchingSets.map((switchingSet) => switchingSet.tracks.map((track) => track.id))).toEqual([
          ['live/video'],
          ['live/screen'],
        ]);
      },
      { timeout: 15_000, interval: 100 }
    );
    // Selection stays on the camera — the rendered switching set is the only
    // one it ranks, so a screen share appearing never changes what is on
    // screen (its canvas is still the camera's, not SCREEN_SIZE).
    expect(signals.state.selectedVideoTrackId.get()).toBe('live/video');
    expect(renderCanvas.width).toBe(CAMERA_SIZE.width);

    // An EXPLICIT cross-set selection is the sanctioned way to watch the
    // screen: `findTrack` resolves ids across sibling switching sets, and
    // the ranker (confined to the selected set) must not clobber it back.
    signals.state.selectedVideoTrackId.set('live/screen');
    await vi.waitFor(
      () => {
        expect(signals.state.selectedVideoTrackId.get()).toBe('live/screen');
        expect(renderCanvas.width).toBe(SCREEN_SIZE.width);
        expect(renderCanvas.height).toBe(SCREEN_SIZE.height);
      },
      { timeout: 15_000, interval: 100 }
    );

    // …and selecting back re-renders the camera.
    signals.state.selectedVideoTrackId.set('live/video');
    await vi.waitFor(
      () => {
        expect(renderCanvas.width).toBe(CAMERA_SIZE.width);
      },
      { timeout: 15_000, interval: 100 }
    );

    // The camera track kept flowing at the wire level the whole time —
    // screen starting never touched it (additive, not a swap).
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(cameraObjectsBeforeScreen + 20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // Audio objects kept flowing from the mic's independent pipeline throughout.
    await vi.waitFor(
      () => {
        expect(hub.objectCount('audio')).toBeGreaterThan(audioObjectsBeforeScreen + 20);
      },
      { timeout: 15_000, interval: 100 }
    );
    // …and the camera subscriber keeps scheduling them.
    const scheduledAfterScreen = signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled;

    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled).toBeGreaterThan(
          scheduledAfterScreen
        );
      },
      { timeout: 15_000, interval: 100 }
    );

    // No track ended and no session churn from adding the screen track: a
    // relay treats a subscribe-stream FIN as the end of the track,
    // freezing every subscriber.
    expect(hub.trackEnds.length).toBe(trackEndsBeforeScreen);
    expect(hub.publisherConnections()).toBe(connectionsBeforeScreen);
    expect(publisher.state.sessionStatus.get()).toBe('live');

    // Orderly unpublish ends every track — now including screen — by
    // FINing the hub's subscribe streams (a bare FIN is the clean track
    // end; PUBLISH_DONE never appears under announce-and-serve).
    publisher.state.publishActivated.set(false);
    await vi.waitFor(
      () => {
        const endedTracks = hub.trackEnds.filter((end) => end.kind === 'subscribe-fin').map((end) => end.trackName);

        expect(endedTracks).toContain('video');
        expect(endedTracks).toContain('screen');
        expect(endedTracks).toContain('audio');
        expect(endedTracks).toContain('catalog');
      },
      { timeout: 10_000 }
    );
  }, 120_000);
});
