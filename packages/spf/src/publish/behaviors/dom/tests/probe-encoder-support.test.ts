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
    cameraTracks: signal<ProbeEncoderSupportState['cameraTracks']>(undefined),
    screenTracks: signal<ProbeEncoderSupportState['screenTracks']>(undefined),
    micTracks: signal<ProbeEncoderSupportState['micTracks']>(undefined),
    encoderSupport: signal<ProbeEncoderSupportState['encoderSupport']>(undefined),
    activeEncodings: signal<ProbeEncoderSupportState['activeEncodings']>(undefined),
    publishError: signal<ProbeEncoderSupportState['publishError']>(undefined),
  };
  disposals.push(probeEncoderSupport.setup({ state, config }));
  return { state };
}

/**
 * Force the video ladder's verdict. `supported()` is read per candidate, so
 * a test can flip a machine from "nothing encodes" to "everything does"
 * between probe runs.
 */
function mockVideoEncoderSupport(supported: () => boolean): void {
  vi.spyOn(VideoEncoder, 'isConfigSupported').mockImplementation(async (config) => ({
    supported: supported(),
    config,
  }));
}

/**
 * Force the audio ladder's verdict per candidate. Needed for any AAC arm:
 * headless Chromium ships no AAC encoder, so the preference walk would
 * always fall back to Opus under the real `isConfigSupported`.
 */
function mockAudioEncoderSupport(supported: (config: AudioEncoderConfig) => boolean): void {
  vi.spyOn(AudioEncoder, 'isConfigSupported').mockImplementation(async (config) => ({
    supported: supported(config),
    config,
  }));
}

const CAMERA_TRACK = { width: 320, height: 240, frameRate: 30 };
const SCREEN_TRACK = { width: 1920, height: 1080, frameRate: 30 };
const MIC_TRACK = { sampleRate: 48_000, channelCount: 1 };

describe('probeEncoderSupport', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('probes real encoder support per kind and picks the active encodings', async () => {
    const { state } = setupProbe();

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
  });

  it('probes only the tracks actually present', async () => {
    const { state } = setupProbe();

    state.micTracks.set({ sampleRate: 48_000, channelCount: 2 });

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.audio).toBeDefined();
    });
    expect(state.encoderSupport.get()!.camera).toBeUndefined();
    expect(state.encoderSupport.get()!.screen).toBeUndefined();
    expect(state.activeEncodings.get()!.camera).toBeUndefined();
    expect(state.activeEncodings.get()!.audio).toMatchObject({ numberOfChannels: 2 });
  });

  it('camera and screen probe independently — one appearing never clobbers the other', async () => {
    const { state } = setupProbe();

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
  });

  it('defaults the screen ladder to a lower framerate/bitrate than the camera (degrade-screen-first)', async () => {
    const { state } = setupProbe();

    state.screenTracks.set(SCREEN_TRACK);

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.screen).toBeDefined();
    });
    expect(state.activeEncodings.get()!.screen).toMatchObject({ framerate: 15, bitrate: 1_500_000 });
  });

  it('keeps the screen defaults when the screen tuning carries explicit undefined fields', async () => {
    // The shape a caller produces by spreading a partial config: the keys
    // are present, so spread order alone would drop the screen defaults.
    const { state } = setupProbe({ screen: { frameRate: undefined, bitrate: undefined } });

    state.screenTracks.set(SCREEN_TRACK);

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.screen).toBeDefined();
    });
    expect(state.activeEncodings.get()!.screen).toMatchObject({ framerate: 15, bitrate: 1_500_000 });
  });

  it('walks the audio codec preference before the Opus default (codec-major ladder)', async () => {
    mockAudioEncoderSupport(() => true);
    const { state } = setupProbe({ audio: { codec: 'mp4a.40.2' } });

    state.micTracks.set({ sampleRate: 44_100, channelCount: 2 });

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.audio).toBeDefined();
    });
    // The preferred codec exhausts its sample rates before Opus gets a turn.
    expect(state.encoderSupport.get()!.audio!.map(({ codec, sampleRate }) => ({ codec, sampleRate }))).toEqual([
      { codec: 'mp4a.40.2', sampleRate: 44_100 },
      { codec: 'mp4a.40.2', sampleRate: 48_000 },
      { codec: 'opus', sampleRate: 44_100 },
      { codec: 'opus', sampleRate: 48_000 },
    ]);
    expect(state.activeEncodings.get()!.audio).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44_100 });
  });

  it('falls back to Opus when the preferred audio codec is unsupported', async () => {
    mockAudioEncoderSupport((config) => config.codec === 'opus');
    const { state } = setupProbe({ audio: { codec: 'mp4a.40.2' } });

    state.micTracks.set(MIC_TRACK);

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.audio).toBeDefined();
    });
    expect(state.activeEncodings.get()!.audio).toMatchObject({ codec: 'opus', sampleRate: 48_000 });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('does not duplicate the ladder when the preferred audio codec is the default', async () => {
    mockAudioEncoderSupport(() => true);
    const { state } = setupProbe({ audio: { codec: 'opus' } });

    state.micTracks.set(MIC_TRACK);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.audio).toBeDefined();
    });
    expect(state.encoderSupport.get()!.audio).toHaveLength(1);
  });

  it('resolves the active encodings through the selectEncoderConfig seam', async () => {
    const chosen: ActiveEncodingsFacts = {};
    const { state } = setupProbe({
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
  });

  it('clears only its own kind when its tracks go away', async () => {
    const { state } = setupProbe();

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
  });

  it('restores the absent facts — not an empty object — when the last kind goes away', async () => {
    const { state } = setupProbe();

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
  });

  it('treats a strategy veto as policy, not failure — no publishError', async () => {
    const { state } = setupProbe({ selectEncoderConfig: () => ({}) });

    state.cameraTracks.set(CAMERA_TRACK);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()?.camera).toBeDefined();
    });
    // The kind probed fine; the strategy chose not to publish it.
    expect(state.encoderSupport.get()!.camera!.length).toBeGreaterThanOrEqual(1);
    expect(state.activeEncodings.get()).toBeUndefined();
    expect(state.publishError.get()).toBeUndefined();
  });

  it('raises an encode publishError when nothing on the kind ladder is supported', async () => {
    mockVideoEncoderSupport(() => false);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);

    await vi.waitFor(() => {
      expect(state.publishError.get()).toBeDefined();
    });
    expect(state.publishError.get()).toMatchObject({
      code: 'encode',
      message: 'No supported encoder configuration for the camera track.',
    });
    expect(state.encoderSupport.get()!.camera).toEqual([]);
    expect(state.activeEncodings.get()).toBeUndefined();
  });

  it('retracts its encode error when the kind is released', async () => {
    mockVideoEncoderSupport(() => false);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });

    // A verdict about a track that no longer exists must not pin the slot.
    state.cameraTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.publishError.get()).toBeUndefined();
    });
  });

  it('retracts its encode error when the kind re-probes successfully', async () => {
    let encodable = false;
    mockVideoEncoderSupport(() => encodable);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });

    // Re-acquire (a fresh tracks identity re-probes through the cleanup).
    encodable = true;
    state.cameraTracks.set({ ...CAMERA_TRACK });

    await vi.waitFor(() => {
      expect(state.activeEncodings.get()?.camera).toBeDefined();
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('reasserts its encode error when another writer frees the slot', async () => {
    mockVideoEncoderSupport(() => false);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });

    // A capture failure takes the slot, then its own writer clears it — the
    // next acquisition attempt does exactly this. Nothing about that fixes
    // an unsupported encoder ladder, so the verdict has to come back.
    state.publishError.set({ code: 'capture', message: 'device exploded' });
    state.publishError.set(undefined);

    await vi.waitFor(() => {
      expect(state.publishError.get()).toMatchObject({
        code: 'encode',
        message: 'No supported encoder configuration for the camera track.',
      });
    });
    // ...and stays put rather than oscillating.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.publishError.get()?.code).toBe('encode');
  });

  it('stops reasserting once the kind is released', async () => {
    mockVideoEncoderSupport(() => false);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });

    state.cameraTracks.set(undefined);
    await vi.waitFor(() => {
      expect(state.publishError.get()).toBeUndefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.publishError.get()).toBeUndefined();
  });

  it('leaves an error another writer put in the slot alone when its kind recovers', async () => {
    mockVideoEncoderSupport(() => false);
    const { state } = setupProbe();

    state.cameraTracks.set(CAMERA_TRACK);
    await vi.waitFor(() => {
      expect(state.publishError.get()?.code).toBe('encode');
    });

    // `publishError` is a single-value multi-writer slot: a capture failure
    // written after ours is the live one, and our retraction is not its.
    const captureError = { code: 'capture', message: 'device exploded' } as const;
    state.publishError.set(captureError);
    state.cameraTracks.set(undefined);

    await vi.waitFor(() => {
      expect(state.encoderSupport.get()).toBeUndefined();
    });
    expect(state.publishError.get()).toBe(captureError);
  });
});
