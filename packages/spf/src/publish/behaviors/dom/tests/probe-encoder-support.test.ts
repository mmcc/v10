import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import {
  type ActiveEncodingsFacts,
  type ProbeEncoderSupportConfig,
  type ProbeEncoderSupportState,
  probeEncoderSupport,
} from '../probe-encoder-support';

const disposals: (() => void)[] = [];

function setupProbe(config: ProbeEncoderSupportConfig = {}) {
  const state = {
    captureTracks: signal<ProbeEncoderSupportState['captureTracks']>(undefined),
    encoderSupport: signal<ProbeEncoderSupportState['encoderSupport']>(undefined),
    activeEncodings: signal<ProbeEncoderSupportState['activeEncodings']>(undefined),
    publishError: signal<ProbeEncoderSupportState['publishError']>(undefined),
  };
  const reactor = probeEncoderSupport.setup({ state, config });
  disposals.push(() => reactor.destroy());
  return { state, reactor };
}

const CAMERA_TRACKS = {
  video: { width: 320, height: 240, frameRate: 30 },
  audio: { sampleRate: 48_000, channelCount: 1 },
};

describe('probeEncoderSupport', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('probes real encoder support and picks the active encodings', async () => {
    const { state } = setupProbe();

    state.captureTracks.set(CAMERA_TRACKS);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()).toBeDefined();
    });
    const support = state.encoderSupport.get()!;
    // Chromium always ships at least VP8 + Opus encoders.
    expect(support.video!.length).toBeGreaterThanOrEqual(1);
    expect(support.audio!.length).toBeGreaterThanOrEqual(1);

    const active = state.activeEncodings.get()!;
    expect(active.video).toBe(support.video![0]);
    expect(active.video).toMatchObject({ width: 320, height: 240, framerate: 30 });
    expect(active.audio).toMatchObject({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('probes only the captured kinds', async () => {
    const { state } = setupProbe();

    state.captureTracks.set({ audio: { sampleRate: 48_000, channelCount: 2 } });

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()).toBeDefined();
    });
    expect(state.encoderSupport.get()!.video).toBeUndefined();
    expect(state.activeEncodings.get()!.video).toBeUndefined();
    expect(state.activeEncodings.get()!.audio).toMatchObject({ numberOfChannels: 2 });
  });

  it('resolves the active encodings through the selectEncoderConfig seam', async () => {
    const chosen: ActiveEncodingsFacts = {};
    const { state } = setupProbe({
      selectEncoderConfig: (support) => {
        chosen.video = support.video?.at(-1);
        return chosen;
      },
    });

    state.captureTracks.set(CAMERA_TRACKS);

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()).toBe(chosen);
    });
    expect(state.activeEncodings.get()!.video).toBe(state.encoderSupport.get()!.video!.at(-1));
  });

  it('clears the facts when the tracks go away', async () => {
    const { state } = setupProbe();

    state.captureTracks.set(CAMERA_TRACKS);
    await vi.waitFor(() => {
      expect(state.activeEncodings.get()).toBeDefined();
    });

    state.captureTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.encoderSupport.get()).toBeUndefined();
      expect(state.activeEncodings.get()).toBeUndefined();
    });
  });
});
