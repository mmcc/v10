import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { LOC_PROPERTY, toLocFrame } from '../../../../media/moq/loc';
import type { PackagedLocFrame } from '../../../../media/moq/loc-packaging';
import type { EncodedChunkSinkMeta } from '../encoder-actor';
import { createVideoEncoderActor } from '../video-encoder';

const VP8_CONFIG: VideoEncoderConfig = {
  codec: 'vp8',
  width: 320,
  height: 240,
  bitrate: 500_000,
  framerate: 30,
};

const AVC_CONFIG: VideoEncoderConfig = {
  codec: 'avc1.42E01F',
  width: 320,
  height: 240,
  bitrate: 500_000,
  framerate: 30,
  avc: { format: 'avc' },
};

const FRAME_DURATION_US = 33_333;
/**
 * Deterministic wallclock for the actor's capture→wallclock timestamp
 * rebase: outputs land at `WALLCLOCK_US + <capture delta>`.
 */
const WALLCLOCK_US = 1_000_000_000_000;

const disposals: (() => void)[] = [];

function setupActor(options?: Parameters<typeof createVideoEncoderActor>[1]) {
  const sunk: { packaged: PackagedLocFrame; meta: EncodedChunkSinkMeta }[] = [];
  const actor = createVideoEncoderActor((packaged, meta) => sunk.push({ packaged, meta }), {
    nowUs: () => WALLCLOCK_US,
    ...options,
  });
  disposals.push(() => actor.destroy());
  return { actor, sunk };
}

/** Real frames off a painted canvas so Chromium's encoders do real work. */
function makeVideoFrame(timestampUs: number): VideoFrame {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d')!;
  context.fillStyle = `hsl(${(timestampUs / 1000) % 360}, 80%, 50%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new VideoFrame(canvas, { timestamp: timestampUs });
}

describe('createVideoEncoderActor', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('encodes real frames, honors keyframe forcing, and reports counters', async () => {
    const { actor, sunk } = setupActor();

    actor.send({ type: 'configure', config: VP8_CONFIG });
    expect(actor.snapshot.get().value).toBe('encoding');

    const closeSpies: MockInstance[] = [];
    for (let i = 0; i < 10; i++) {
      const frame = makeVideoFrame(i * FRAME_DURATION_US);
      closeSpies.push(vi.spyOn(frame, 'close'));
      // Force a key on the "group cadence" (frames 0 and 5).
      actor.send({ type: 'encode', frame, keyFrame: i % 5 === 0 });
    }
    // The actor takes frame ownership at send(): every frame is closed
    // synchronously in the handler regardless of encode outcome.
    for (const close of closeSpies) expect(close).toHaveBeenCalled();

    actor.send({ type: 'flush' });
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.encodedFrames).toBe(10);
    });

    const counters = actor.snapshot.get().context;
    expect(counters.encodedBytes).toBeGreaterThan(0);
    expect(counters.droppedFrames).toBe(0);
    expect(counters.keyframes).toBeGreaterThanOrEqual(2);
    expect(counters.lastTimestampUs).toBe(WALLCLOCK_US + 9 * FRAME_DURATION_US);

    expect(sunk).toHaveLength(10);
    const keyTimestamps = sunk.filter(({ meta }) => meta.keyframe).map(({ meta }) => meta.timestampUs);
    expect(keyTimestamps).toContain(WALLCLOCK_US);
    expect(keyTimestamps).toContain(WALLCLOCK_US + 5 * FRAME_DURATION_US);
    for (const { packaged, meta } of sunk) {
      expect(meta.track).toBe('video');
      expect(meta.byteLength).toBe(packaged.payload.byteLength);
      expect(packaged.payload.byteLength).toBeGreaterThan(0);
    }

    // The packaged output is what the LOC extraction side consumes.
    const first = sunk[0]!;
    const extracted = toLocFrame({
      objectId: 0,
      properties: first.packaged.properties,
      payload: first.packaged.payload,
    });
    expect(extracted).toMatchObject({ timestampUs: WALLCLOCK_US, isKey: true });
  });

  it('drops delta frames under backpressure, never keyframes, and closes every frame', async () => {
    const { actor } = setupActor({ maxQueueDepth: 0 });
    actor.send({ type: 'configure', config: VP8_CONFIG });

    const closeSpies: MockInstance[] = [];
    const send = (index: number, keyFrame: boolean) => {
      const frame = makeVideoFrame(index * FRAME_DURATION_US);
      closeSpies.push(vi.spyOn(frame, 'close'));
      actor.send({ type: 'encode', frame, keyFrame });
    };

    // One synchronous flood: the first encode raises encodeQueueSize
    // above the zero threshold, so the following deltas must drop while
    // the forced keyframe must not.
    send(0, true);
    for (let i = 1; i <= 8; i++) send(i, false);
    send(9, true);

    expect(actor.snapshot.get().context.droppedFrames).toBe(8);
    for (const close of closeSpies) expect(close).toHaveBeenCalled();

    actor.send({ type: 'flush' });
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.encodedFrames).toBe(2);
    });
    expect(actor.snapshot.get().context.keyframes).toBe(2);
  });

  it('carries the avc decoder description on packaged keyframes', async () => {
    const { supported } = await VideoEncoder.isConfigSupported(AVC_CONFIG);
    // Chromium builds without H.264 encoders can't exercise this path.
    if (!supported) return;

    const { actor, sunk } = setupActor();
    actor.send({ type: 'configure', config: AVC_CONFIG });
    actor.send({ type: 'encode', frame: makeVideoFrame(0), keyFrame: true });
    actor.send({ type: 'encode', frame: makeVideoFrame(FRAME_DURATION_US) });
    actor.send({ type: 'flush' });

    await vi.waitFor(() => {
      expect(sunk.length).toBe(2);
    });
    const key = sunk.find(({ meta }) => meta.keyframe)!;
    expect(key.packaged.properties.some(({ type }) => type === LOC_PROPERTY.VIDEO_CONFIG)).toBe(true);
    const extracted = toLocFrame({ objectId: 0, properties: key.packaged.properties, payload: key.packaged.payload });
    expect(extracted?.videoConfig?.byteLength).toBeGreaterThan(0);
  });

  it('closes frames sent while unconfigured or closed instead of leaking them', () => {
    const { actor, sunk } = setupActor();

    const early = makeVideoFrame(0);
    const earlyClose = vi.spyOn(early, 'close');
    actor.send({ type: 'encode', frame: early });
    expect(earlyClose).toHaveBeenCalled();
    expect(actor.snapshot.get().value).toBe('unconfigured');

    actor.send({ type: 'configure', config: VP8_CONFIG });
    actor.send({ type: 'close' });
    expect(actor.snapshot.get().value).toBe('closed');

    const late = makeVideoFrame(FRAME_DURATION_US);
    const lateClose = vi.spyOn(late, 'close');
    actor.send({ type: 'encode', frame: late });
    expect(lateClose).toHaveBeenCalled();
    expect(sunk).toHaveLength(0);
    expect(actor.snapshot.get().context.encodedFrames).toBe(0);
  });
});
