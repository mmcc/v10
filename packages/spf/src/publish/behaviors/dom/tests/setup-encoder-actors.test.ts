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
const SCREEN_VP8_CONFIG: VideoEncoderConfig = {
  codec: 'vp8',
  width: 1920,
  height: 1080,
  bitrate: 1_500_000,
  framerate: 15,
};
const OPUS_CONFIG: AudioEncoderConfig = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: 96_000 };

function setup(config: SetupEncoderActorsConfig = {}) {
  const state = {
    activeEncodings: signal<SetupEncoderActorsState['activeEncodings']>(undefined),
    publishError: signal<SetupEncoderActorsState['publishError']>(undefined),
  };
  const context = {
    cameraStream: signal<SetupEncoderActorsContext['cameraStream']>(undefined),
    screenStream: signal<SetupEncoderActorsContext['screenStream']>(undefined),
    micStream: signal<SetupEncoderActorsContext['micStream']>(undefined),
    cameraEncoderActor: signal<SetupEncoderActorsContext['cameraEncoderActor']>(undefined),
    screenEncoderActor: signal<SetupEncoderActorsContext['screenEncoderActor']>(undefined),
    audioEncoderActor: signal<SetupEncoderActorsContext['audioEncoderActor']>(undefined),
  };
  const cleanup = setupEncoderActors.setup({ state, context, config });
  return { state, context, cleanup };
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
    vi.restoreAllMocks();
  });

  it('creates and configures the camera and mic encoder actors independently', async () => {
    const { state, context, cleanup } = setup();
    const { stream } = makeCanvasStream();

    context.cameraStream.set(stream);
    context.micStream.set(stream);
    state.activeEncodings.set({ camera: VP8_CONFIG, audio: OPUS_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.audioEncoderActor.get()).toBeDefined();
    });
    const cameraActor = context.cameraEncoderActor.get()!;
    const audioActor = context.audioEncoderActor.get()!;
    // Configured at creation — ready to encode.
    expect(cameraActor.snapshot.get().value).toBe('encoding');
    expect(audioActor.snapshot.get().value).toBe('encoding');

    // Camera stream release tears down only the camera actor.
    context.cameraStream.set(undefined);
    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeUndefined();
    });
    expect(cameraActor.snapshot.get().value).toBe('destroyed');
    expect(context.audioEncoderActor.get()).toBe(audioActor);
    expect(audioActor.snapshot.get().value).toBe('encoding');

    cleanup();
  });

  it('creates only the actors the active encodings name', async () => {
    const { state, context, cleanup } = setup();
    context.cameraStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ camera: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    expect(context.screenEncoderActor.get()).toBeUndefined();
    expect(context.audioEncoderActor.get()).toBeUndefined();

    cleanup();
  });

  it('runs a screen encoder alongside the camera one, independently destroyed', async () => {
    const { state, context, cleanup } = setup();
    const cameraStream = makeCanvasStream().stream;
    const screenStream = makeCanvasStream().stream;
    context.cameraStream.set(cameraStream);
    context.screenStream.set(screenStream);
    state.activeEncodings.set({ camera: VP8_CONFIG, screen: SCREEN_VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.screenEncoderActor.get()).toBeDefined();
    });
    const cameraActor = context.cameraEncoderActor.get()!;
    const screenActor = context.screenEncoderActor.get()!;

    context.screenStream.set(undefined);
    await vi.waitFor(() => {
      expect(context.screenEncoderActor.get()).toBeUndefined();
    });
    expect(screenActor.snapshot.get().value).toBe('destroyed');
    expect(context.cameraEncoderActor.get()).toBe(cameraActor);
    expect(cameraActor.snapshot.get().value).toBe('encoding');

    cleanup();
  });

  it('keeps the live camera and mic actors across a screen encoding coming and going', async () => {
    const { state, context, cleanup } = setup();
    context.cameraStream.set(makeCanvasStream().stream);
    context.micStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ camera: VP8_CONFIG, audio: OPUS_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.audioEncoderActor.get()).toBeDefined();
    });
    const cameraActor = context.cameraEncoderActor.get()!;
    const audioActor = context.audioEncoderActor.get()!;

    // How the screen probe writes it: a fresh merged object carrying the
    // other kinds' configs by reference (probe-encoder-support.ts spreads
    // the previous one). Tracking `activeEncodings` whole would destroy and
    // recreate both live actors here — a video gap and a mic dropout for a
    // change that belongs to neither.
    context.screenStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ ...state.activeEncodings.get(), screen: SCREEN_VP8_CONFIG });
    await vi.waitFor(() => {
      expect(context.screenEncoderActor.get()).toBeDefined();
    });
    expect(context.cameraEncoderActor.get()).toBe(cameraActor);
    expect(context.audioEncoderActor.get()).toBe(audioActor);
    expect(cameraActor.snapshot.get().value).toBe('encoding');
    expect(audioActor.snapshot.get().value).toBe('encoding');

    // Ending the share is the same write in reverse.
    const withoutScreen = { ...state.activeEncodings.get() };
    delete withoutScreen.screen;
    context.screenStream.set(undefined);
    state.activeEncodings.set(withoutScreen);
    await vi.waitFor(() => {
      expect(context.screenEncoderActor.get()).toBeUndefined();
    });
    expect(context.cameraEncoderActor.get()).toBe(cameraActor);
    expect(context.audioEncoderActor.get()).toBe(audioActor);
    expect(cameraActor.snapshot.get().value).toBe('encoding');
    expect(audioActor.snapshot.get().value).toBe('encoding');

    cleanup();
  });

  it('rebuilds only the kind whose own config changed, with the new config', async () => {
    const { state, context, cleanup } = setup();
    context.cameraStream.set(makeCanvasStream().stream);
    context.micStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ camera: VP8_CONFIG, audio: OPUS_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.audioEncoderActor.get()).toBeDefined();
    });
    const firstCamera = context.cameraEncoderActor.get()!;
    const audioActor = context.audioEncoderActor.get()!;

    const configure = vi.spyOn(VideoEncoder.prototype, 'configure');
    const nextCamera: VideoEncoderConfig = { ...VP8_CONFIG, bitrate: 250_000 };
    state.activeEncodings.set({ ...state.activeEncodings.get(), camera: nextCamera });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.cameraEncoderActor.get()).not.toBe(firstCamera);
    });
    expect(firstCamera.snapshot.get().value).toBe('destroyed');
    // The narrowed dependency still propagates a deliberate same-kind change.
    expect(configure).toHaveBeenCalledWith(nextCamera);
    expect(context.audioEncoderActor.get()).toBe(audioActor);
    expect(audioActor.snapshot.get().value).toBe('encoding');

    cleanup();
  });

  it("rebuilds a kind's actor when its active encoding changes identity", async () => {
    const { state, context, cleanup } = setup();
    context.cameraStream.set(makeCanvasStream().stream);
    state.activeEncodings.set({ camera: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    const first = context.cameraEncoderActor.get()!;

    state.activeEncodings.set({ camera: { ...VP8_CONFIG, bitrate: 250_000 } });
    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).not.toBe(first);
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    expect(first.snapshot.get().value).toBe('destroyed');

    cleanup();
  });

  it('threads the chunk sink through to the actors, labeling camera vs screen', async () => {
    const sunk: EncodedChunkSinkMeta[] = [];
    const chunkSink: EncodedChunkSink = (_packaged, meta) => sunk.push(meta);
    const { state, context, cleanup } = setup({ chunkSink });
    const { stream, canvas } = makeCanvasStream();
    context.cameraStream.set(stream);
    state.activeEncodings.set({ camera: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    const actor = context.cameraEncoderActor.get()!;
    const beforeUs = Date.now() * 1000;
    actor.send({ type: 'encode', frame: new VideoFrame(canvas, { timestamp: 0 }), keyFrame: true });
    actor.send({ type: 'flush' });

    await vi.waitFor(() => {
      expect(sunk).toHaveLength(1);
    });
    expect(sunk[0]).toMatchObject({ track: 'camera', keyframe: true });
    // The actor rebases the capture timestamp onto the shared wallclock
    // anchored at the first encoded frame (see encoder-actor.ts).
    expect(sunk[0]!.timestampUs).toBeGreaterThanOrEqual(beforeUs);
    expect(sunk[0]!.timestampUs).toBeLessThanOrEqual(Date.now() * 1000);

    cleanup();
  });
});
