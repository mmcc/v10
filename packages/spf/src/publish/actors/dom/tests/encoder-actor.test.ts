import { afterEach, describe, expect, it } from 'vitest';
import { LOC_PROPERTY } from '../../../../media/moq/loc';
import type { EncodedChunkLike, PackagedLocFrame } from '../../../../media/moq/loc-packaging';
import type { EncodedChunkSinkMeta, EncoderInstance, EncoderOutputMetadata } from '../encoder-actor';
import { createEncoderActor } from '../encoder-actor';

/**
 * Description carriage contract, exercised through a stubbed codec:
 * WebCodecs emits `metadata.decoderConfig` only on the FIRST output after
 * a configure (and on changes), but the LOC Config property must ride
 * EVERY keyframe — a late-joining subscriber configures its `avc`-format
 * decoder from whatever group it lands on, so a keyframe without the
 * description is undecodable for it.
 */

interface FakeFrame {
  close(): void;
  timestamp: number;
}

function makeChunk(type: 'key' | 'delta', timestamp: number, byte = 0xab): EncodedChunkLike {
  return {
    type,
    timestamp,
    byteLength: 4,
    copyTo: (destination: Uint8Array) => destination.set([byte, byte, byte, byte]),
  };
}

function descriptionOf(
  packaged: PackagedLocFrame,
  property: number = LOC_PROPERTY.VIDEO_CONFIG
): Uint8Array | undefined {
  const pair = packaged.properties.find(({ type }) => type === property);
  return pair && typeof pair.value !== 'number' ? pair.value : undefined;
}

const disposals: (() => void)[] = [];

function setupStubbedActor(options: { nowUs?: () => number; track?: 'video' | 'audio' } = {}) {
  const sunk: { packaged: PackagedLocFrame; meta: EncodedChunkSinkMeta }[] = [];
  let output!: (chunk: EncodedChunkLike, metadata?: EncoderOutputMetadata) => void;
  const actor = createEncoderActor<{ id: number }, FakeFrame>({
    ...options,
    track: options.track ?? 'video',
    sink: (packaged, meta) => sunk.push({ packaged, meta }),
    create: (callbacks) => {
      output = callbacks.output;
      const instance: EncoderInstance<{ id: number }, FakeFrame> = {
        configure: () => undefined,
        encode: () => undefined,
        flush: async () => undefined,
        close: () => undefined,
        encodeQueueSize: 0,
      };
      return instance;
    },
  });
  disposals.push(() => actor.destroy());
  return { actor, sunk, emit: (chunk: EncodedChunkLike, metadata?: EncoderOutputMetadata) => output(chunk, metadata) };
}

function makeFrame(timestamp: number): FakeFrame {
  return { timestamp, close: () => undefined };
}

function locTimestampOf(packaged: PackagedLocFrame): number | undefined {
  const property = packaged.properties.find(({ type }) => type === LOC_PROPERTY.TIMESTAMP);
  return typeof property?.value === 'number' ? property.value : undefined;
}

describe('createEncoderActor', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('carries the cached decoder description on every keyframe, not just the first output', () => {
    const { actor, sunk, emit } = setupStubbedActor();
    actor.send({ type: 'configure', config: { id: 1 } });

    const description = Uint8Array.from([1, 66, 224, 31, 255]);
    // Group 1: the codec reports the config on the first output only.
    emit(makeChunk('key', 0), { decoderConfig: { description } });
    emit(makeChunk('delta', 33_000));
    emit(makeChunk('delta', 66_000));
    // Groups 2 and 3: keyframes with NO metadata — the WebCodecs shape.
    emit(makeChunk('key', 2_000_000));
    emit(makeChunk('delta', 2_033_000));
    emit(makeChunk('key', 4_000_000));

    const keys = sunk.filter(({ meta }) => meta.keyframe);
    expect(keys).toHaveLength(3);
    for (const { packaged } of keys) {
      expect(descriptionOf(packaged)).toEqual(description);
    }
    // Delta frames never carry the Config property.
    for (const { packaged, meta } of sunk) {
      if (!meta.keyframe) expect(descriptionOf(packaged)).toBeUndefined();
    }
  });

  it('labels an audio track description as Audio Config, not Video Config', () => {
    const { actor, sunk, emit } = setupStubbedActor({ track: 'audio' });
    actor.send({ type: 'configure', config: { id: 1 } });

    // AAC-shaped: an AudioSpecificConfig on the first output, then none —
    // audio chunks are all 'key', so the config must ride every frame.
    const description = Uint8Array.from([0x11, 0x90]);
    emit(makeChunk('key', 0), { decoderConfig: { description } });
    emit(makeChunk('key', 20_000));

    expect(sunk).toHaveLength(2);
    for (const { packaged } of sunk) {
      expect(descriptionOf(packaged, LOC_PROPERTY.AUDIO_CONFIG)).toEqual(description);
      expect(descriptionOf(packaged, LOC_PROPERTY.VIDEO_CONFIG)).toBeUndefined();
    }
  });

  it('does not alias the codec-owned description buffer', () => {
    const { sunk, emit, actor } = setupStubbedActor();
    actor.send({ type: 'configure', config: { id: 1 } });

    const description = Uint8Array.from([9, 9, 9]);
    emit(makeChunk('key', 0), { decoderConfig: { description } });
    description.fill(0); // the codec may reuse its buffer
    emit(makeChunk('key', 2_000_000));

    expect(descriptionOf(sunk[1]!.packaged)).toEqual(Uint8Array.from([9, 9, 9]));
  });

  it('invalidates the cached description on reconfigure until the codec reports a new one', () => {
    const { actor, sunk, emit } = setupStubbedActor();
    actor.send({ type: 'configure', config: { id: 1 } });

    const first = Uint8Array.from([1, 1, 1]);
    emit(makeChunk('key', 0), { decoderConfig: { description: first } });
    expect(descriptionOf(sunk[0]!.packaged)).toEqual(first);

    // Mid-stream reconfigure: the old extradata belongs to the old config.
    actor.send({ type: 'configure', config: { id: 2 } });
    emit(makeChunk('key', 2_000_000));
    expect(descriptionOf(sunk[1]!.packaged)).toBeUndefined();

    // WebCodecs reports a fresh decoderConfig on the first post-configure
    // output; from then on the new description rides every keyframe.
    const second = Uint8Array.from([2, 2, 2]);
    emit(makeChunk('key', 4_000_000), { decoderConfig: { description: second } });
    emit(makeChunk('key', 6_000_000));
    expect(descriptionOf(sunk[2]!.packaged)).toEqual(second);
    expect(descriptionOf(sunk[3]!.packaged)).toEqual(second);
  });

  it('rebases output timestamps onto the wallclock anchored at the first encoded frame', () => {
    // Capture clock 7 200 000 000 µs (two "hours" into some per-source
    // domain); shared wallclock 1 000 000 000 000 µs.
    const { actor, sunk, emit } = setupStubbedActor({ nowUs: () => 1_000_000_000_000 });
    actor.send({ type: 'configure', config: { id: 1 } });

    actor.send({ type: 'encode', frame: makeFrame(7_200_000_000), keyFrame: true });
    emit(makeChunk('key', 7_200_000_000));
    emit(makeChunk('delta', 7_200_033_000));

    // Offset = wallclock − first frame timestamp; intra-track deltas keep
    // capture pacing exactly.
    expect(sunk[0]!.meta.timestampUs).toBe(1_000_000_000_000);
    expect(locTimestampOf(sunk[0]!.packaged)).toBe(1_000_000_000_000);
    expect(sunk[1]!.meta.timestampUs).toBe(1_000_000_033_000);
    expect(locTimestampOf(sunk[1]!.packaged)).toBe(1_000_000_033_000);
  });

  it('keeps the wallclock anchor across a mid-stream reconfigure', () => {
    let now = 1_000_000_000_000;
    const { actor, sunk, emit } = setupStubbedActor({ nowUs: () => now });
    actor.send({ type: 'configure', config: { id: 1 } });
    actor.send({ type: 'encode', frame: makeFrame(500), keyFrame: true });
    emit(makeChunk('key', 500));

    // A reconfigure on the same capture stream must not re-anchor: the
    // frames stay on one continuous capture clock.
    now = 2_000_000_000_000;
    actor.send({ type: 'configure', config: { id: 2 } });
    actor.send({ type: 'encode', frame: makeFrame(2_000_500), keyFrame: true });
    emit(makeChunk('key', 2_000_500));

    expect(sunk[0]!.meta.timestampUs).toBe(1_000_000_000_000);
    expect(sunk[1]!.meta.timestampUs).toBe(1_000_002_000_000);
  });
});
