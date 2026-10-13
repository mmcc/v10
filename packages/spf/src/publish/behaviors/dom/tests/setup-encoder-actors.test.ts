import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

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
    encoderInitData: signal<SetupEncoderActorsState['encoderInitData']>(undefined),
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

  it("continues a kind's published timeline across an actor rebuild", async () => {
    const sunk: EncodedChunkSinkMeta[] = [];
    const chunkSink: EncodedChunkSink = (_packaged, meta) => sunk.push(meta);
    const { state, context, cleanup } = setup({ chunkSink });
    const first = makeCanvasStream();

    context.cameraStream.set(first.stream);
    state.activeEncodings.set({ camera: VP8_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    const firstActor = context.cameraEncoderActor.get()!;

    firstActor.send({ type: 'encode', frame: new VideoFrame(first.canvas, { timestamp: 0 }), keyFrame: true });
    firstActor.send({ type: 'flush' });
    await vi.waitFor(() => {
      expect(sunk).toHaveLength(1);
    });

    // The wallclock steps back an hour between the epochs (an NTP step, or
    // simply the skew a long-lived anchor accumulated): a rebuilt actor
    // opening a FRESH wallclock anchor would publish the switched source an
    // hour behind the surviving tracks.
    const realNow = Date.now.bind(Date);

    vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3_600_000);

    // A capture-source switch: new stream identity, same kind — the rebuild
    // this behavior owns.
    const second = makeCanvasStream();

    context.cameraStream.set(second.stream);
    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
      expect(context.cameraEncoderActor.get()).not.toBe(firstActor);
    });
    const secondActor = context.cameraEncoderActor.get()!;

    // A new source stamps on its own capture base too.
    secondActor.send({
      type: 'encode',
      frame: new VideoFrame(second.canvas, { timestamp: 500_000_000 }),
      keyFrame: true,
    });
    secondActor.send({ type: 'flush' });
    await vi.waitFor(() => {
      expect(sunk).toHaveLength(2);
    });

    // One clock domain across the rebuild: forward by the real acquisition
    // gap (test-scale: well under 30 s) — never the stepped wallclock, never
    // the new capture base.
    expect(sunk[1]!.timestampUs).toBeGreaterThan(sunk[0]!.timestampUs);
    expect(sunk[1]!.timestampUs - sunk[0]!.timestampUs).toBeLessThan(30_000_000);

    cleanup();
  });

  it("publishes a kind's reported decoder description as encoderInitData and clears it with the actor", async () => {
    const { state, context, cleanup } = setup();
    const { stream, canvas } = makeCanvasStream();
    // `avc` (AVCC) format is what makes the codec report the avcC as
    // `decoderConfig.description` — the fact under test.
    const H264_CONFIG: VideoEncoderConfig = {
      codec: 'avc1.42E01F',
      width: 320,
      height: 240,
      bitrate: 500_000,
      framerate: 30,
      avc: { format: 'avc' },
    };

    context.cameraStream.set(stream);
    state.activeEncodings.set({ camera: H264_CONFIG });

    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeDefined();
    });
    const actor = context.cameraEncoderActor.get()!;

    actor.send({ type: 'encode', frame: new VideoFrame(canvas, { timestamp: 0 }), keyFrame: true });
    actor.send({ type: 'flush' });

    await vi.waitFor(() => {
      expect(state.encoderInitData.get()?.camera).toBeDefined();
    });
    // An avcC, not an empty buffer: configurationVersion is always 1.
    expect(state.encoderInitData.get()!.camera![0]).toBe(1);

    // The description describes THIS actor's output config — releasing the
    // stream destroys the actor and must retract the fact with it.
    context.cameraStream.set(undefined);
    await vi.waitFor(() => {
      expect(context.cameraEncoderActor.get()).toBeUndefined();
    });
    expect(state.encoderInitData.get()).toBeUndefined();

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
