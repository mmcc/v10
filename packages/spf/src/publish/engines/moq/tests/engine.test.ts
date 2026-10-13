import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { EncodedChunkSinkMeta } from '../engine';
import { createMoqPublishEngine } from '../engine';

const disposals: (() => void)[] = [];

/**
 * A real, continuously producing video-only `MediaStream` built without any capture device: an animated canvas capture
 * (frames only flow while the canvas repaints). Real tracks give `MediaStreamTrackProcessor` real frames in headless
 * Chromium, where no fake camera exists.
 */
function makeLiveVideoStream(): MediaStream {
  const canvas = document.createElement('canvas');

  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d')!;
  let hue = 0;
  const paint = setInterval(() => {
    hue = (hue + 7) % 360;
    context.fillStyle = `hsl(${hue}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);

  disposals.push(() => clearInterval(paint));
  return canvas.captureStream(30);
}

/** A real, continuously producing audio-only `MediaStream` via a WebAudio oscillator. */
function makeLiveAudioStream(): MediaStream {
  const audioContext = new AudioContext({ sampleRate: 48_000 });

  disposals.push(() => void audioContext.close().catch(() => undefined));
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();

  oscillator.connect(destination);
  oscillator.start();
  // Fire-and-forget: a suspended context just means silent audio frames.
  void audioContext.resume().catch(() => undefined);
  return destination.stream;
}

/**
 * The camera and mic pipelines both call `getUserMedia`, distinguished only by which of `video`/`audio` is truthy in
 * the constraints — mirror that dispatch so each pipeline gets its own live stream instead of sharing one (which would
 * make releasing one stop the other's tracks).
 */
function mockGetUserMedia() {
  return vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints) => {
    if (constraints?.audio) return makeLiveAudioStream();

    return makeLiveVideoStream();
  });
}

describe('createMoqPublishEngine', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('drives capture → probe → encode → publishStats end to end', async () => {
    mockGetUserMedia();
    const sunk: EncodedChunkSinkMeta[] = [];
    const engine = createMoqPublishEngine({
      statsIntervalMs: 250,
      groupDurationSec: 1,
      chunkSink: (_packaged, meta) => sunk.push(meta),
    });

    disposals.push(() => void engine.destroy());

    engine.state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(engine.state.cameraState.get()).toBe('active');
      expect(engine.state.micState.get()).toBe('active');
    });

    // Probe facts land once the track settings are known.
    await vi.waitFor(() => {
      expect(engine.state.encoderSupport.get()?.camera?.length).toBeGreaterThanOrEqual(1);
      expect(engine.state.activeEncodings.get()?.camera).toBeDefined();
      expect(engine.state.activeEncodings.get()?.audio).toMatchObject({ codec: 'opus' });
    });

    // The actor cluster follows the active encodings.
    await vi.waitFor(() => {
      expect(engine.context.cameraEncoderActor.get()).toBeDefined();
      expect(engine.context.audioEncoderActor.get()).toBeDefined();
    });

    // Real frames flow through the pump into real encoders: the sampled
    // stats go nonzero within a few seconds.
    await vi.waitFor(
      () => {
        const stats = engine.state.publishStats.get();

        expect(stats?.encodedFps ?? 0).toBeGreaterThan(0);
        expect(stats?.videoBitrate ?? 0).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 250 }
    );
    const stats = engine.state.publishStats.get()!;

    // No endpoint → no session or track publishers in this run: nothing
    // has been handed to a transport, and the subscriber count is unknown.
    expect(stats.bytesSent).toBe(0);
    expect(stats.droppedGroups).toBe(0);
    expect(stats.subscriberCount).toBeNaN();
    expect(engine.state.publishError.get()).toBeUndefined();

    // Packaged chunks reached the configured sink, keyframes first.
    expect(sunk.some((meta) => meta.track === 'camera' && meta.keyframe)).toBe(true);
    expect(sunk[0]!.keyframe).toBe(true);

    // Releasing the camera winds its encode stage down without touching the mic.
    const cameraActor = engine.context.cameraEncoderActor.get()!;

    engine.state.cameraActive.set(false);
    await vi.waitFor(() => {
      expect(engine.context.cameraEncoderActor.get()).toBeUndefined();
    });
    expect(cameraActor.snapshot.get().value).toBe('destroyed');
    // The mic pipeline is independent — releasing the camera (the only
    // video source) also collapses the mic's own gate (neither camera nor
    // screen wants to capture anymore), so it winds down too.
    await vi.waitFor(() => {
      expect(engine.state.publishStats.get()).toBeUndefined();
    });
  }, 30_000);

  it('publishes audio-only: micActive alone captures and encodes with no video pipeline touched', async () => {
    const getUserMedia = mockGetUserMedia();
    const engine = createMoqPublishEngine({ statsIntervalMs: 250 });

    disposals.push(() => void engine.destroy());

    engine.state.micActive.set(true);
    await vi.waitFor(() => {
      expect(engine.state.micState.get()).toBe('active');
    });
    // The one getUserMedia call asked for audio alone — no camera in the
    // permission prompt, no hardware indicator, and (below) no video
    // track in the encodings the catalog would advertise (issue #26).
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(engine.state.cameraState.get()).toBe('idle');
    expect(engine.state.screenShareState.get()).toBe('idle');

    await vi.waitFor(() => {
      expect(engine.state.activeEncodings.get()?.audio).toMatchObject({ codec: 'opus' });
      expect(engine.context.audioEncoderActor.get()).toBeDefined();
    });
    expect(engine.state.activeEncodings.get()?.camera).toBeUndefined();
    expect(engine.state.activeEncodings.get()?.screen).toBeUndefined();
    expect(engine.context.cameraEncoderActor.get()).toBeUndefined();
    expect(engine.state.publishError.get()).toBeUndefined();

    // Releasing the sole source winds the whole capture stage down.
    engine.state.micActive.set(false);
    await vi.waitFor(() => {
      expect(engine.state.micState.get()).toBe('idle');
      expect(engine.context.audioEncoderActor.get()).toBeUndefined();
    });
  }, 30_000);

  it('forces keyframes on the configured group cadence', async () => {
    mockGetUserMedia();
    const videoKeyTimestamps: number[] = [];
    let lastVideoTimestampUs = 0;
    const engine = createMoqPublishEngine({
      groupDurationSec: 0.5,
      chunkSink: (_packaged, meta) => {
        if (meta.track !== 'camera') return;

        lastVideoTimestampUs = meta.timestampUs;

        if (meta.keyframe) videoKeyTimestamps.push(meta.timestampUs);
      },
    });

    disposals.push(() => void engine.destroy());

    engine.state.cameraActive.set(true);
    // Wait for ~2s of media time so several 0.5s groups elapse.
    await vi.waitFor(
      () => {
        expect(videoKeyTimestamps.length).toBeGreaterThanOrEqual(3);
        expect(lastVideoTimestampUs - videoKeyTimestamps[0]!).toBeGreaterThanOrEqual(1_500_000);
      },
      { timeout: 15_000, interval: 250 }
    );

    // Keyframes are spaced by the group duration in media time — never
    // closer than the cadence allows.
    for (let i = 1; i < videoKeyTimestamps.length; i++) {
      expect(videoKeyTimestamps[i]! - videoKeyTimestamps[i - 1]!).toBeGreaterThanOrEqual(500_000);
    }
  }, 30_000);

  it('runs camera and screen as independent, simultaneous video pipelines', async () => {
    mockGetUserMedia();
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockImplementation(async () => makeLiveVideoStream());
    const tracks = new Set<EncodedChunkSinkMeta['track']>();
    const engine = createMoqPublishEngine({
      groupDurationSec: 1,
      chunkSink: (_packaged, meta) => tracks.add(meta.track),
    });

    disposals.push(() => void engine.destroy());

    engine.state.cameraActive.set(true);
    engine.state.screenShareActive.set(true);

    await vi.waitFor(() => {
      expect(engine.state.cameraState.get()).toBe('active');
      expect(engine.state.screenShareState.get()).toBe('active');
      expect(engine.context.cameraEncoderActor.get()).toBeDefined();
      expect(engine.context.screenEncoderActor.get()).toBeDefined();
    });

    await vi.waitFor(
      () => {
        expect(tracks.has('camera')).toBe(true);
        expect(tracks.has('screen')).toBe(true);
      },
      { timeout: 15_000, interval: 250 }
    );

    // Stopping the screen share leaves the camera pipeline untouched.
    const screenActor = engine.context.screenEncoderActor.get()!;

    engine.state.screenShareActive.set(false);
    await vi.waitFor(() => {
      expect(engine.context.screenEncoderActor.get()).toBeUndefined();
    });
    expect(screenActor.snapshot.get().value).toBe('destroyed');
    expect(engine.state.cameraState.get()).toBe('active');
  }, 30_000);

  it('still honors the deprecated `video` tuning as the camera tuning', async () => {
    mockGetUserMedia();
    // The pre-rename config key: clients that never migrated must keep
    // tuning the camera ladder rather than be silently ignored.
    const engine = createMoqPublishEngine({ video: { width: 320, height: 240, bitrate: 900_000 } });

    disposals.push(() => void engine.destroy());

    engine.state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(engine.state.activeEncodings.get()?.camera).toBeDefined();
    });
    expect(engine.state.activeEncodings.get()!.camera).toMatchObject({ width: 320, height: 240, bitrate: 900_000 });
  });

  it('prefers `camera` over the deprecated `video` alias when both are given', async () => {
    mockGetUserMedia();
    const engine = createMoqPublishEngine({
      camera: { width: 320, height: 240, bitrate: 1_100_000 },
      video: { width: 320, height: 240, bitrate: 900_000 },
    });

    disposals.push(() => void engine.destroy());

    engine.state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(engine.state.activeEncodings.get()?.camera).toBeDefined();
    });
    expect(engine.state.activeEncodings.get()!.camera).toMatchObject({ bitrate: 1_100_000 });
  });
});
