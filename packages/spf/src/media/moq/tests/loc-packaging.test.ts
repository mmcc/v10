import { describe, expect, it } from 'vite-plus/test';

import { LOC_PROPERTY, toLocFrame } from '../loc';
import { type EncodedChunkLike, microsecondsToLocTimestamp, packageLocFrame } from '../loc-packaging';

/** Structural chunk stand-in — what a WebCodecs encoded chunk exposes. */
function chunkOf(bytes: Uint8Array, overrides: Partial<EncodedChunkLike> = {}): EncodedChunkLike {
  return {
    type: 'key',
    timestamp: 0,
    byteLength: bytes.byteLength,
    copyTo: (destination) => destination.set(bytes),
    ...overrides,
  };
}

describe('microsecondsToLocTimestamp', () => {
  it('passes microseconds through without a timescale', () => {
    expect(microsecondsToLocTimestamp(1_500_000)).toBe(1_500_000);
    expect(microsecondsToLocTimestamp(1_500_000, 1_000_000)).toBe(1_500_000);
  });

  it('rescales to the requested timescale', () => {
    expect(microsecondsToLocTimestamp(1_000_000, 90_000)).toBe(90_000);
    expect(microsecondsToLocTimestamp(500_000, 48_000)).toBe(24_000);
  });
});

describe('packageLocFrame', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  it('packages the chunk bytes with explicit timestamp + timescale properties', () => {
    const packaged = packageLocFrame(chunkOf(bytes, { timestamp: 1_500_000 }));

    expect(packaged.payload).toEqual(bytes);
    expect(packaged.properties).toEqual([
      { type: LOC_PROPERTY.TIMESTAMP, value: 1_500_000 },
      { type: LOC_PROPERTY.TIMESCALE, value: 1_000_000 },
    ]);
  });

  it('round-trips through toLocFrame extraction', () => {
    const packaged = packageLocFrame(chunkOf(bytes, { timestamp: 1_500_000 }));

    const frame = toLocFrame({ objectId: 0, properties: packaged.properties, payload: packaged.payload });

    expect(frame).toMatchObject({ timestampUs: 1_500_000, isKey: true, payload: bytes });
    expect(frame?.videoConfig).toBeUndefined();
  });

  it('round-trips a rescaled timestamp through toLocFrame', () => {
    const packaged = packageLocFrame(chunkOf(bytes, { timestamp: 2_000_000 }), { timescale: 90_000 });

    expect(packaged.properties).toContainEqual({ type: LOC_PROPERTY.TIMESTAMP, value: 180_000 });
    expect(packaged.properties).toContainEqual({ type: LOC_PROPERTY.TIMESCALE, value: 90_000 });
    const frame = toLocFrame({ objectId: 2, properties: packaged.properties, payload: packaged.payload });

    expect(frame).toMatchObject({ timestampUs: 2_000_000, isKey: false });
  });

  it('carries the video decoder config beside key chunks only', () => {
    const config = new Uint8Array([1, 100, 0, 31]);

    const key = packageLocFrame(chunkOf(bytes, { type: 'key', timestamp: 1 }), { videoConfig: config });
    const delta = packageLocFrame(chunkOf(bytes, { type: 'delta', timestamp: 2 }), { videoConfig: config });

    expect(key.properties).toContainEqual({ type: LOC_PROPERTY.VIDEO_CONFIG, value: config });
    expect(delta.properties.some(({ type }) => type === LOC_PROPERTY.VIDEO_CONFIG)).toBe(false);

    const keyFrame = toLocFrame({ objectId: 0, properties: key.properties, payload: key.payload });

    expect(keyFrame?.videoConfig).toEqual(config);
    const deltaFrame = toLocFrame({ objectId: 1, properties: delta.properties, payload: delta.payload });

    expect(deltaFrame?.videoConfig).toBeUndefined();
  });

  it('labels an audio decoder config as Audio Config, not Video Config', () => {
    const config = new Uint8Array([0x11, 0x90]);

    const packaged = packageLocFrame(chunkOf(bytes, { type: 'key', timestamp: 1 }), { audioConfig: config });

    expect(packaged.properties).toContainEqual({ type: LOC_PROPERTY.AUDIO_CONFIG, value: config });
    expect(packaged.properties.some(({ type }) => type === LOC_PROPERTY.VIDEO_CONFIG)).toBe(false);

    // Same key-only rule as Video Config — WebCodecs audio chunks are all
    // 'key' in practice, but the packaging contract is kind-agnostic.
    const delta = packageLocFrame(chunkOf(bytes, { type: 'delta', timestamp: 2 }), { audioConfig: config });

    expect(delta.properties.some(({ type }) => type === LOC_PROPERTY.AUDIO_CONFIG)).toBe(false);
  });

  it('emits the loc-04 wire ids', () => {
    // Literal ids, not LOC_PROPERTY: these are the codepoints loc-04 §6.1
    // registers, so the test has to fail if the constants drift. 0x10
    // TIMESTAMP in particular replaced draft-02/03's 0x06.
    const packaged = packageLocFrame(chunkOf(bytes, { type: 'key', timestamp: 1 }), {
      videoConfig: new Uint8Array([1]),
      audioConfig: new Uint8Array([2]),
    });

    expect(packaged.properties.map(({ type }) => type)).toEqual([0x10, 0x08, 0x0d, 0x0f]);
  });

  it('copies the payload out of the chunk', () => {
    const source = Uint8Array.from(bytes);
    const packaged = packageLocFrame(chunkOf(source, { timestamp: 3 }));

    source.fill(0);
    expect(packaged.payload).toEqual(bytes);
  });
});
