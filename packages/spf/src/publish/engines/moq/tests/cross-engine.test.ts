import { afterEach, describe, expect, it, vi } from 'vitest';
// The real playback engine, from the `@videojs/spf/moq` entry module —
// parent-owned reference implementation; used, never modified.
import { createMoqEngine, type MoqEngineSignals } from '../../../../playback/engines/moq/index';
import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';

/**
 * Cross-engine regression suite: the real publish engine (DEFAULT encoder
 * config — H.264 in `annexb` bitstream format, self-describing keyframes;
 * see `probe-encoder-support.ts` for why `avc` + LOC Config carriage was
 * abandoned) publishing through an in-memory draft-19 relay hub to the
 * real playback engine rendering onto a canvas.
 *
 * Covers the real-world publisher bugs:
 * - a LATE-joining subscriber (after ≥1 group boundary) must reach decoded
 *   video with the default codec config;
 * - screen share starting ADDITIVELY mid-session — the whole point of the
 *   multi-source redesign — must keep the session and the camera's
 *   PUBLISHed tracks alive (no PUBLISH_DONE, no reconnect) while the new
 *   `screen` track arrives on the subscriber as its own content: a second
 *   video switching set, never a quality alternate the ABR ranker may swap
 *   the camera for;
 * - audio (the mic's own always-on pipeline) must keep flowing to the
 *   subscriber throughout, unaffected by screen starting or stopping.
 */

const disposals: (() => void)[] = [];

const CAMERA_SIZE = { width: 320, height: 240 } as const;
const SCREEN_SIZE = { width: 480, height: 360 } as const;

/** An animated canvas track, optionally with oscillator audio, standing in for a device. */
function makeSyntheticStream(size: { width: number; height: number }, withAudio: boolean): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d')!;
  let hue = 0;
  const paint = setInterval(() => {
    hue = (hue + 11) % 360;
    context.fillStyle = `hsl(${hue}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  disposals.push(() => clearInterval(paint));
  const stream = canvas.captureStream(30);

  if (withAudio) {
    const audioContext = new AudioContext({ sampleRate: 48_000 });
    disposals.push(() => void audioContext.close().catch(() => undefined));
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    void audioContext.resume().catch(() => undefined);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }
  return stream;
}

/**
 * Stub capture: camera and mic each get their own video-only / audio-only
 * stream (dispatched on which of `video`/`audio` the constraints ask for —
 * mirroring the two independent `getUserMedia` callers); screen share's
 * `getDisplayMedia` returns a different-resolution video-only stream.
 */
function installCaptureStubs(): void {
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints?: MediaStreamConstraints) => {
    if (constraints?.audio) return makeSyntheticStream(CAMERA_SIZE, true); // audio-only ask: the mic pipeline
    return makeSyntheticStream(CAMERA_SIZE, false); // video-only ask: the camera pipeline
  });
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia: (constraints?: unknown) => Promise<MediaStream>;
  };
  vi.spyOn(mediaDevices, 'getDisplayMedia').mockImplementation(async () => makeSyntheticStream(SCREEN_SIZE, false));
}

/** A playback engine subscribed to the catalog, with a canvas + audio context wired up. */
function createSubscriber(hub: ReturnType<typeof createRelayHub>) {
  let signals!: MoqEngineSignals;
  const player = createMoqEngine({
    createMoqTransport: () => hub.connectSubscriber(),
    onSignalsReady: (refs) => {
      signals = refs;
    },
  });
  disposals.push(() => void player.destroy());

  const canvas = document.createElement('canvas');
  const audioContext = new AudioContext({ sampleRate: 48_000 });
  disposals.push(() => void audioContext.close().catch(() => undefined));
  void audioContext.resume().catch(() => undefined);
  signals.context.renderSurface.set(canvas);
  signals.context.audioContext.set(audioContext);
  signals.state.presentation.set({ url: 'moqt://relay.test/live#msf:live--catalog' });
  signals.state.loadActivated.set(true);

  return { player, signals, canvas };
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

    // ── Publish (default codec config: avc1, annexb format) ──────────────
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

    // ── Let ≥1 group boundary pass before anyone subscribes ──────────────
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(35); // > one full 1s group at 30fps
        expect(hub.objectCount('audio')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // ── Late join: the real playback engine, subscribed to the catalog ───
    const { canvas: renderCanvas, signals } = createSubscriber(hub);

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
    const publishDonesBeforeScreen = hub.publishDones.length;
    const connectionsBeforeScreen = hub.publisherConnections();

    publisher.state.screenShareActive.set(true);

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
    // real relay treats PUBLISH_DONE as the end of the track, freezing
    // every subscriber.
    expect(hub.publishDones.length).toBe(publishDonesBeforeScreen);
    expect(hub.publisherConnections()).toBe(connectionsBeforeScreen);
    expect(publisher.state.sessionStatus.get()).toBe('live');

    // Orderly unpublish ends every track — now including screen — with PUBLISH_DONE.
    publisher.state.publishActivated.set(false);
    await vi.waitFor(
      () => {
        const doneTracks = hub.publishDones.map((done) => done.trackName);
        expect(doneTracks).toContain('video');
        expect(doneTracks).toContain('screen');
        expect(doneTracks).toContain('audio');
        expect(doneTracks).toContain('catalog');
      },
      { timeout: 10_000 }
    );
  }, 120_000);
});
