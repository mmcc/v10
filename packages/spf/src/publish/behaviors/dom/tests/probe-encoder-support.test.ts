import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import {
  type ActiveEncodingsFacts,
  type ProbeEncoderSupportConfig,
  type ProbeEncoderSupportState,
  probeEncoderSupport,
} from '../probe-encoder-support';

function setupProbe(config: ProbeEncoderSupportConfig = {}) {
  const state = {
    cameraTracks: signal<ProbeEncoderSupportState['cameraTracks']>(undefined),
    screenTracks: signal<ProbeEncoderSupportState['screenTracks']>(undefined),
    micTracks: signal<ProbeEncoderSupportState['micTracks']>(undefined),
    encoderSupport: signal<ProbeEncoderSupportState['encoderSupport']>(undefined),
    activeEncodings: signal<ProbeEncoderSupportState['activeEncodings']>(undefined),
    publishError: signal<ProbeEncoderSupportState['publishError']>(undefined),
  };
  const cleanup = probeEncoderSupport.setup({ state, config });
  return { state, cleanup };
}

const CAMERA_TRACK = { width: 320, height: 240, frameRate: 30 };
const SCREEN_TRACK = { width: 1920, height: 1080, frameRate: 30 };
const MIC_TRACK = { sampleRate: 48_000, channelCount: 1 };

describe('probeEncoderSupport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes real encoder support per kind and picks the active encodings', async () => {
    const { state, cleanup } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    state.micTracks.set(MIC_TRACK);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.camera).toBeDefined();
      expect(state.encoderSupport.get()?.audio).toBeDefined();
    });
    const support = state.encoderSupport.get()!;
    // Chromium always ships at least VP8 + Opus encoders.
    expect(support.camera!.length).toBeGreaterThanOrEqual(1);
    expect(support.audio!.length).toBeGreaterThanOrEqual(1);

    const active = state.activeEncodings.get()!;
    expect(active.camera).toBe(support.camera![0]);
    expect(active.camera).toMatchObject({ width: 320, height: 240, framerate: 30 });
    expect(active.audio).toMatchObject({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
    expect(active.screen).toBeUndefined();
    expect(state.publishError.get()).toBeUndefined();

    cleanup();
  });

  it('probes only the tracks actually present', async () => {
    const { state, cleanup } = setupProbe();

    state.micTracks.set({ sampleRate: 48_000, channelCount: 2 });

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.audio).toBeDefined();
    });
    expect(state.encoderSupport.get()!.camera).toBeUndefined();
    expect(state.encoderSupport.get()!.screen).toBeUndefined();
    expect(state.activeEncodings.get()!.camera).toBeUndefined();
    expect(state.activeEncodings.get()!.audio).toMatchObject({ numberOfChannels: 2 });

    cleanup();
  });

  it('camera and screen probe independently — one appearing never clobbers the other', async () => {
    const { state, cleanup } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.camera).toBeDefined();
    });
    const cameraEncoding = state.activeEncodings.get()!.camera;

    state.screenTracks.set(SCREEN_TRACK);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.screen).toBeDefined();
    });
    expect(state.activeEncodings.get()!.camera).toBe(cameraEncoding);
    expect(state.activeEncodings.get()!.screen).toMatchObject({ width: 1920, height: 1080 });

    // Screen going away must not touch camera's slot.
    state.screenTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.screen).toBeUndefined();
    });
    expect(state.activeEncodings.get()!.camera).toBe(cameraEncoding);

    cleanup();
  });

  it('defaults the screen ladder to a lower framerate/bitrate than the camera (degrade-screen-first)', async () => {
    const { state, cleanup } = setupProbe();

    state.screenTracks.set(SCREEN_TRACK);

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.screen).toBeDefined();
    });
    expect(state.activeEncodings.get()!.screen).toMatchObject({ framerate: 15 });

    cleanup();
  });

  it('resolves the active encodings through the selectEncoderConfig seam', async () => {
    const chosen: ActiveEncodingsFacts = {};
    const { state, cleanup } = setupProbe({
      selectEncoderConfig: (support) => {
        chosen.camera = support.camera?.at(-1);
        return chosen;
      },
    });

    state.cameraTracks.set(CAMERA_TRACK);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.camera).toBeDefined();
    });
    expect(state.activeEncodings.get()!.camera).toBe(chosen.camera);
    expect(state.activeEncodings.get()!.camera).toBe(state.encoderSupport.get()!.camera!.at(-1));

    cleanup();
  });

  it('clears only its own kind when its tracks go away', async () => {
    const { state, cleanup } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    state.micTracks.set(MIC_TRACK);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.camera).toBeDefined();
      expect(state.activeEncodings.get()?.audio).toBeDefined();
    });

    state.cameraTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.camera).toBeUndefined();
      expect(state.activeEncodings.get()?.camera).toBeUndefined();
    });
    expect(state.activeEncodings.get()?.audio).toBeDefined();

    cleanup();
  });

  it('restores the absent facts — not an empty object — when the last kind goes away', async () => {
    const { state, cleanup } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    state.micTracks.set(MIC_TRACK);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.camera).toBeDefined();
      expect(state.activeEncodings.get()?.audio).toBeDefined();
    });

    state.cameraTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.camera).toBeUndefined();
    });
    // A kind is still active — the facts stay.
    expect(state.encoderSupport.get()).toBeDefined();
    expect(state.activeEncodings.get()).toBeDefined();

    state.micTracks.set(undefined);
    await vi.waitFor(() => {
      // `{}` is truthy: `deriveCatalog` gates on presence, so an emptied
      // object keeps it publishing a track-less catalog forever.
      expect(state.encoderSupport.get()).toBeUndefined();
      expect(state.activeEncodings.get()).toBeUndefined();
    });

    cleanup();
  });

  it('leaves the active encodings absent when the strategy vetoes the only kind', async () => {
    const { state, cleanup } = setupProbe({ selectEncoderConfig: () => ({}) });

    state.cameraTracks.set(CAMERA_TRACK);

    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });
    expect(state.encoderSupport.get()?.camera).toBeDefined();
    expect(state.activeEncodings.get()).toBeUndefined();

    cleanup();
  });
});
