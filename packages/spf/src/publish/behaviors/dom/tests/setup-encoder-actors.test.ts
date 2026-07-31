import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import type { EncodedChunkSink, EncodedChunkSinkMeta } from '../../../actors/dom/encoder-actor';
import {
  type SetupEncoderActorsConfig,
  type SetupEncoderActorsContext,
  type SetupEncoderActorsState,
  setupEncoderActors,
} from '../setup-encoder-actors';

const VP8_CONFIG: VideoEncoderConfig = { codec: 'vp8', width: 320, height: 240, bitrate: 500_000, framerate: 30 };
const OPUS_CONFIG: AudioEncoderConfig = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: 96_000 };

const disposals: (() => void)[] = [];

function setup(config: SetupEncoderActorsConfig = {}) {
  const state = {
    activeEncodings: signal<SetupEncoderActorsState['activeEncodings']>(undefined),
    publishError: signal<SetupEncoderActorsState['publishError']>(undefined),
  };
  const context = {
    captureStream: signal<SetupEncoderActorsContext['captureStream']>(undefined),
    videoEncoderActor: signal<SetupEncoderActorsContext['videoEncoderActor']>(undefined),
    audioEncoderActor: signal<SetupEncoderActorsContext['audioEncoderActor']>(undefined),
  };
  const reactor = setupEncoderActors.setup({ state, context, config });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

function makeCanvasStream(): { stream: MediaStream; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  canvas.getContext('2d')!.fillRect(0, 0, 10, 10);
  return { stream: canvas.captureStream(30), canvas };
}

describe('setupEncoderActors', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('creates, configures, and reverse-destroys the encoder actor pair', async () => {
    const { state, context } = setup();
    const { stream } = makeCanvasStream();

    context.captureStream.set(stream);
    state.activeEncodings.set({ video: VP8_CONFIG, audio: OPUS_CONFIG });

    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).toBeDefined();
      expect(context.audioEncoderActor.get()).toBeDefined();
    });
    const videoActor = context.videoEncoderActor.get()!;
    const audioActor = context.audioEncoderActor.get()!;
    // Configured at creation — ready to encode.
    expect(videoActor.snapshot.get().value).toBe('encoding');
    expect(audioActor.snapshot.get().value).toBe('encoding');

    // Stream release tears the cluster down and clears the slots.
    context.captureStream.set(undefined);
    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).toBeUndefined();
      expect(context.audioEncoderActor.get()).toBeUndefined();
    });
    expect(videoActor.snapshot.get().value).toBe('destroyed');
    expect(audioActor.snapshot.get().value).toBe('destroyed');
  });

  it('creates only the actors the active encodings name', async () => {
    const { state, context } = setup();
    context.captureStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ video: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).toBeDefined();
    });
    expect(context.audioEncoderActor.get()).toBeUndefined();
  });

  it('rebuilds the cluster when the active encodings change identity', async () => {
    const { state, context } = setup();
    context.captureStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ video: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).toBeDefined();
    });
    const first = context.videoEncoderActor.get()!;

    state.activeEncodings.set({ video: { ...VP8_CONFIG, bitrate: 250_000 } });
    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).not.toBe(first);
      expect(context.videoEncoderActor.get()).toBeDefined();
    });
    expect(first.snapshot.get().value).toBe('destroyed');
  });

  it('threads the chunk sink through to the actors', async () => {
    const sunk: EncodedChunkSinkMeta[] = [];
    const chunkSink: EncodedChunkSink = (_packaged, meta) => sunk.push(meta);
    const { state, context } = setup({ chunkSink });
    const { stream, canvas } = makeCanvasStream();
    context.captureStream.set(stream);
    state.activeEncodings.set({ video: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.videoEncoderActor.get()).toBeDefined();
    });
    const actor = context.videoEncoderActor.get()!;
    actor.send({ type: 'encode', frame: new VideoFrame(canvas, { timestamp: 0 }), keyFrame: true });
    actor.send({ type: 'flush' });

    await vi.waitFor(() => {
      expect(sunk).toHaveLength(1);
    });
    expect(sunk[0]).toMatchObject({ track: 'video', keyframe: true, timestampUs: 0 });
  });
});
