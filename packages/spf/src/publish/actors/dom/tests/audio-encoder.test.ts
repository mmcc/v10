import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { PackagedLocFrame } from '../../../../media/moq/loc-packaging';
import { createAudioEncoderActor } from '../audio-encoder';
import type { EncodedChunkSinkMeta } from '../encoder-actor';

const OPUS_CONFIG: AudioEncoderConfig = {
  codec: 'opus',
  sampleRate: 48_000,
  numberOfChannels: 1,
  bitrate: 96_000,
};

/** 10 ms of (silent) mono audio at 48 kHz. */
const FRAMES_PER_CHUNK = 480;
const CHUNK_DURATION_US = 10_000;

const disposals: (() => void)[] = [];

function makeAudioData(timestampUs: number): AudioData {
  return new AudioData({
    format: 'f32-planar',
    sampleRate: OPUS_CONFIG.sampleRate,
    numberOfFrames: FRAMES_PER_CHUNK,
    numberOfChannels: 1,
    timestamp: timestampUs,
    data: new Float32Array(FRAMES_PER_CHUNK),
  });
}

describe('createAudioEncoderActor', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('encodes real audio data and reports counters through the sink', async () => {
    const sunk: { packaged: PackagedLocFrame; meta: EncodedChunkSinkMeta }[] = [];
    const actor = createAudioEncoderActor((packaged, meta) => sunk.push({ packaged, meta }));
    disposals.push(() => actor.destroy());

    actor.send({ type: 'configure', config: OPUS_CONFIG });
    expect(actor.snapshot.get().value).toBe('encoding');

    const closeSpies: MockInstance[] = [];
    // Half a second of audio — plenty for Opus to emit several packets.
    for (let i = 0; i < 50; i++) {
      const data = makeAudioData(i * CHUNK_DURATION_US);
      closeSpies.push(vi.spyOn(data, 'close'));
      actor.send({ type: 'encode', frame: data });
    }
    for (const close of closeSpies) expect(close).toHaveBeenCalled();

    actor.send({ type: 'flush' });
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.encodedFrames).toBeGreaterThanOrEqual(10);
    });

    const counters = actor.snapshot.get().context;
    expect(counters.encodedBytes).toBeGreaterThan(0);
    expect(counters.droppedFrames).toBe(0);
    // Every audio chunk is independently decodable — all keyframes.
    expect(counters.keyframes).toBe(counters.encodedFrames);
    expect(counters.lastTimestampUs).toBeGreaterThan(0);

    expect(sunk.length).toBe(counters.encodedFrames);
    for (const { packaged, meta } of sunk) {
      expect(meta.track).toBe('audio');
      expect(meta.keyframe).toBe(true);
      expect(packaged.payload.byteLength).toBeGreaterThan(0);
      expect(meta.byteLength).toBe(packaged.payload.byteLength);
    }
  });

  it('closes audio data sent before configuration', () => {
    const actor = createAudioEncoderActor(() => undefined);
    disposals.push(() => actor.destroy());

    const data = makeAudioData(0);
    const close = vi.spyOn(data, 'close');
    actor.send({ type: 'encode', frame: data });

    expect(close).toHaveBeenCalled();
    expect(actor.snapshot.get().context.encodedFrames).toBe(0);
  });
});
