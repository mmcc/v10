import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import {
  type AcquireMicrophoneContext,
  type AcquireMicrophoneState,
  type AcquireScreenShareState,
  acquireMicrophone,
  acquireScreenShare,
} from '../acquire-capture-source';

function makeState(initial: AcquireMicrophoneState = {}): StateSignals<AcquireMicrophoneState> {
  return {
    micActive: signal(initial.micActive ?? false),
    cameraActive: signal(initial.cameraActive ?? false),
    screenShareActive: signal(initial.screenShareActive ?? false),
    audioInputDeviceId: signal(initial.audioInputDeviceId ?? ''),
    micState: signal(initial.micState ?? 'idle'),
    micTracks: signal(initial.micTracks),
    publishError: signal(initial.publishError),
  };
}

function makeContext(initial: AcquireMicrophoneContext = {}): ContextSignals<AcquireMicrophoneContext> {
  return {
    micStream: signal(initial.micStream),
  };
}

const disposals: (() => void)[] = [];

function setupAcquire() {
  const state = makeState();
  const context = makeContext();
  const reactor = acquireMicrophone.setup({ state, context });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

class FakeMediaStreamTrack extends EventTarget {
  enabled = true;
  readonly kind = 'audio';
  readonly stop = vi.fn();
  readonly #settings: MediaTrackSettings;

  constructor(settings: MediaTrackSettings = {}) {
    super();
    this.#settings = settings;
  }

  getSettings(): MediaTrackSettings {
    return this.#settings;
  }
}

class FakeMediaStream {
  readonly #tracks: FakeMediaStreamTrack[];
  constructor(tracks: FakeMediaStreamTrack[]) {
    this.#tracks = tracks;
  }
  getTracks(): FakeMediaStreamTrack[] {
    return [...this.#tracks];
  }
  getVideoTracks(): FakeMediaStreamTrack[] {
    return [];
  }
  getAudioTracks(): FakeMediaStreamTrack[] {
    return [...this.#tracks];
  }
}

const asStream = (stream: FakeMediaStream) => stream as unknown as MediaStream;

describe('acquireMicrophone', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('acquires audio-only once either camera or screen wants to capture', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack({ sampleRate: 48000, channelCount: 1 })]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    expect(state.micState.get()).toBe('idle');
    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(context.micStream.get()).toBe(asStream(stream));
    expect(state.micTracks.get()?.sampleRate).toBe(48000);
  });

  it('acquires for screen share alone too — either video source is enough', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state } = setupAcquire();

    state.screenShareActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
  });

  it('never re-acquires when switching between camera and screen while staying active — the confirmed defect this fixes', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const acquiredStream = context.micStream.get();

    // Switch from camera to screen while both bracket a moment of overlap —
    // the mic pipeline reads only the OR of the two, never which one.
    state.screenShareActive.set(true);
    state.cameraActive.set(false);

    // No re-render/microtask should trigger a second acquire: the effect's
    // tracked dependency is audioInputDeviceId alone.
    await Promise.resolve();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(context.micStream.get()).toBe(acquiredStream);
    expect(state.micState.get()).toBe('active');
  });

  it('re-acquires on an audioInputDeviceId change without touching video state', async () => {
    const first = new FakeMediaStream([new FakeMediaStreamTrack({ deviceId: 'mic-1' })]);
    const second = new FakeMediaStream([new FakeMediaStreamTrack({ deviceId: 'mic-2' })]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockResolvedValueOnce(asStream(first))
      .mockResolvedValueOnce(asStream(second));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micTracks.get()?.deviceId).toBe('mic-1');
    });

    state.audioInputDeviceId.set('mic-2');

    await vi.waitFor(() => {
      expect(state.micTracks.get()?.deviceId).toBe('mic-2');
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: false });
    for (const track of first.getTracks()) expect(track.stop).toHaveBeenCalled();
    expect(context.micStream.get()).toBe(asStream(second));
  });

  it('releases when neither camera nor screen is active anymore', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });

    state.cameraActive.set(false);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('idle');
      expect(context.micStream.get()).toBeUndefined();
    });
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalled();
  });

  it("maps NotAllowedError to denied without touching the video pipelines' gate", async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError')
    );
    const { state } = setupAcquire();

    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('denied');
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('releases the microphone when the only video source ends outside our control — no hot mic', async () => {
    // The confirmed privacy defect this pins: the mic gates on the video
    // sources' INTENT, so the screen pipeline must consume that intent on
    // 'ended' (browser-native "Stop sharing") or the mic captures forever
    // with nothing live. Both behaviors run composed, sharing the gate
    // signals the way the real engine wires them.
    const screenTrack = new FakeMediaStreamTrack();
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(new FakeMediaStream([screenTrack])));
    const micTrack = new FakeMediaStreamTrack();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(new FakeMediaStream([micTrack])));

    const state = makeState();
    const context = makeContext();
    const screenState = {
      screenShareActive: state.screenShareActive,
      screenShareState: signal<AcquireScreenShareState['screenShareState']>('idle'),
      screenTracks: signal<AcquireScreenShareState['screenTracks']>(undefined),
      publishError: state.publishError,
    };
    const screenReactor = acquireScreenShare.setup({
      state: screenState,
      context: { screenStream: signal<MediaStream | undefined>(undefined) },
    });
    disposals.push(() => screenReactor.destroy());
    const micReactor = acquireMicrophone.setup({ state, context });
    disposals.push(() => micReactor.destroy());

    state.screenShareActive.set(true);
    await vi.waitFor(() => {
      expect(screenState.screenShareState.get()).toBe('active');
      expect(state.micState.get()).toBe('active');
    });

    screenTrack.dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(state.screenShareActive.get()).toBe(false);
      expect(state.micState.get()).toBe('idle');
      expect(context.micStream.get()).toBeUndefined();
    });
    expect(micTrack.stop).toHaveBeenCalled();
  });

  it('publishes video-only on a mic-less machine — quiet idle, no capture error', async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValue(new DOMException('no mic', 'NotFoundError'));
    const { state } = setupAcquire();

    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('idle');
    });
    expect(state.publishError.get()).toBeUndefined();
    expect(state.micTracks.get()).toBeUndefined();
  });

  it('falls back to the default device when the selected microphone is gone', async () => {
    const fallback = new FakeMediaStream([new FakeMediaStreamTrack({ deviceId: 'default-mic' })]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(Object.assign(new Error('unsatisfiable'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce(asStream(fallback));
    const { state } = setupAcquire();

    state.audioInputDeviceId.set('mic-gone');
    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, { audio: { deviceId: { exact: 'mic-gone' } }, video: false });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true, video: false });
    expect(state.micTracks.get()?.deviceId).toBe('default-mic');
    expect(state.publishError.get()).toBeUndefined();
  });

  it('re-acquires on devicechange after the mic ended out-of-band — replug recovery', async () => {
    const first = new FakeMediaStream([new FakeMediaStreamTrack({ deviceId: 'mic-1' })]);
    const second = new FakeMediaStream([new FakeMediaStreamTrack({ deviceId: 'mic-1' })]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockResolvedValueOnce(asStream(first))
      .mockResolvedValueOnce(asStream(second));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });

    first.getTracks()[0]!.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('ended');
    });
    // A dead mic is not a publish failure, and it must not consume the
    // VIDEO intent — camera capture continues without audio.
    expect(state.publishError.get()).toBeUndefined();
    expect(state.cameraActive.get()).toBe(true);

    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
      expect(context.micStream.get()).toBe(asStream(second));
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('acquires with the microphone as the sole capture source — no video source required', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack({ sampleRate: 48000, channelCount: 1 })]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.micActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    // Audio-only constraints: no camera or screen share in the permission
    // prompt (issue #26 — users decline "camera + microphone" who would
    // have accepted "microphone").
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(context.micStream.get()).toBe(asStream(stream));
  });

  it('releases when micActive drops and no video source holds the gate', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.micActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });

    state.micActive.set(false);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('idle');
      expect(context.micStream.get()).toBeUndefined();
    });
    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalled();
  });

  it('keeps capturing when micActive drops while a video source is active — video intent implies the mic', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.micActive.set(true);
    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    const acquiredStream = context.micStream.get();

    state.micActive.set(false);

    // micActive is acquisition intent, not a mute: with the camera still
    // holding the gate the pipeline neither releases nor re-acquires.
    await Promise.resolve();
    await Promise.resolve();
    expect(state.micState.get()).toBe('active');
    expect(context.micStream.get()).toBe(acquiredStream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('consumes micActive on denial — the next true write is a real retry edge', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError')
    );
    const { state } = setupAcquire();

    state.micActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('denied');
      expect(state.micActive.get()).toBe(false);
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('consumes micActive when a sole-source mic ends out-of-band, keeping the terminal status', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.micActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });

    stream.getTracks()[0]!.dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('ended');
      expect(state.micActive.get()).toBe(false);
      expect(context.micStream.get()).toBeUndefined();
    });
  });

  it('re-acquires on a micActive rising edge while a video source holds the gate — explicit retry over a parked mic', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
      .mockResolvedValueOnce(asStream(stream));
    const { state, context } = setupAcquire();

    // The implied mic is denied while the camera captures on: the reactor
    // never leaves 'active', so no gate rising edge is coming.
    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('denied');
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    // The explicit intent write is the retry — it must re-fire acquisition
    // without disturbing the video pipeline or the device selection.
    state.micActive.set(true);

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(context.micStream.get()).toBe(asStream(stream));
    expect(state.cameraActive.get()).toBe(true);
  });

  it('never restarts a healthy mic on a micActive rising edge — retry nudges parked statuses only', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    const acquiredStream = context.micStream.get();

    state.micActive.set(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(context.micStream.get()).toBe(acquiredStream);
    expect(state.micState.get()).toBe('active');
  });

  it('holds micActive through a missing-device idle — a mic-only session waits for the plug-in', async () => {
    const mic = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(new DOMException('no mic', 'NotFoundError'))
      .mockResolvedValueOnce(asStream(mic));
    const { state } = setupAcquire();

    state.micActive.set(true);
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('idle');
    });
    // A quiet idle is not a termination: the intent survives, so the gate
    // stays hot and the devicechange nudge below can still re-acquire.
    expect(state.micActive.get()).toBe(true);

    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
  });

  it('re-acquires on devicechange after a missing-device idle — mic plugged in later', async () => {
    const mic = new FakeMediaStream([new FakeMediaStreamTrack()]);
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(new DOMException('no mic', 'NotFoundError'))
      .mockResolvedValueOnce(asStream(mic));
    const { state } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('idle');
    });

    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    await vi.waitFor(() => {
      expect(state.micState.get()).toBe('active');
    });
    expect(state.publishError.get()).toBeUndefined();
  });
});
