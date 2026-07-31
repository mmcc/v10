import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncodedChunkSinkMeta } from '../engine';
import { createMoqPublishEngine } from '../engine';

const disposals: (() => void)[] = [];

/**
 * A real, continuously producing `MediaStream` built without any capture
 * device: an animated canvas capture for video (frames only flow while
 * the canvas repaints) plus a WebAudio oscillator routed to a stream
 * destination for audio. Real tracks give `MediaStreamTrackProcessor`
 * real frames in headless Chromium, where no fake camera exists.
 */
function makeLiveCameraStream(): MediaStream {
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
  const stream = canvas.captureStream(30);

  const audioContext = new AudioContext({ sampleRate: 48_000 });
  disposals.push(() => void audioContext.close().catch(() => undefined));
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  // Fire-and-forget: a suspended context just means silent audio frames.
  void audioContext.resume().catch(() => undefined);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  return stream;
}

describe('createMoqPublishEngine', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('drives capture → probe → encode → publishStats end to end', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(makeLiveCameraStream());
    const sunk: EncodedChunkSinkMeta[] = [];
    const engine = createMoqPublishEngine({
      statsIntervalMs: 250,
      groupDurationSec: 1,
      chunkSink: (_packaged, meta) => sunk.push(meta),
    });
    disposals.push(() => void engine.destroy());

    engine.state.captureSource.set({ kind: 'camera' });
    await vi.waitFor(() => {
      expect(engine.state.captureStatus.get()).toBe('active');
    });

    // Probe facts land once the track settings are known.
    await vi.waitFor(() => {
      expect(engine.state.encoderSupport.get()?.video?.length).toBeGreaterThanOrEqual(1);
      expect(engine.state.activeEncodings.get()?.video).toBeDefined();
      expect(engine.state.activeEncodings.get()?.audio).toMatchObject({ codec: 'opus' });
    });

    // The actor cluster follows the active encodings.
    await vi.waitFor(() => {
      expect(engine.context.videoEncoderActor.get()).toBeDefined();
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
    expect(sunk.some((meta) => meta.track === 'video' && meta.keyframe)).toBe(true);
    expect(sunk[0]!.keyframe).toBe(true);

    // Releasing capture winds the encode stage down.
    const videoActor = engine.context.videoEncoderActor.get()!;
    engine.state.captureSource.set(undefined);
    await vi.waitFor(() => {
      expect(engine.context.videoEncoderActor.get()).toBeUndefined();
      expect(engine.state.publishStats.get()).toBeUndefined();
    });
    expect(videoActor.snapshot.get().value).toBe('destroyed');
  }, 30_000);

  it('forces keyframes on the configured group cadence', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(makeLiveCameraStream());
    const videoKeyTimestamps: number[] = [];
    let lastVideoTimestampUs = 0;
    const engine = createMoqPublishEngine({
      groupDurationSec: 0.5,
      chunkSink: (_packaged, meta) => {
        if (meta.track !== 'video') return;
        lastVideoTimestampUs = meta.timestampUs;
        if (meta.keyframe) videoKeyTimestamps.push(meta.timestampUs);
      },
    });
    disposals.push(() => void engine.destroy());

    engine.state.captureSource.set({ kind: 'camera' });
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
});
