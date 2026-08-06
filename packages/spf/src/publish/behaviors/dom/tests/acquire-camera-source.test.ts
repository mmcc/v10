import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import {
  type AcquireCameraSourceContext,
  type AcquireCameraSourceState,
  acquireCameraSource,
} from '../acquire-capture-source';

function makeState(initial: AcquireCameraSourceState = {}): StateSignals<AcquireCameraSourceState> {
  return {
    cameraActive: signal(initial.cameraActive ?? false),
    videoInputDeviceId: signal(initial.videoInputDeviceId ?? ''),
    cameraState: signal(initial.cameraState ?? 'idle'),
    cameraTracks: signal(initial.cameraTracks),
    publishError: signal(initial.publishError),
  };
}

function makeContext(initial: AcquireCameraSourceContext = {}): ContextSignals<AcquireCameraSourceContext> {
  return {
    cameraStream: signal(initial.cameraStream),
  };
}

const disposals: (() => void)[] = [];

function setupAcquire() {
  const state = makeState();
  const context = makeContext();
  const reactor = acquireCameraSource.setup({ state, context });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A real `MediaStream` with a real video track: canvas capture. A real
 * track gives real `getSettings()` / `stop()` / `'ended'` semantics in
 * headless Chromium, where no fake camera exists.
 */
function makeRealCameraStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.getContext('2d')!.fillRect(0, 0, 10, 10);
  return canvas.captureStream(30);
}

class FakeMediaStreamTrack extends EventTarget {
  enabled = true;
  readonly kind: 'video' | 'audio';
  readonly stop = vi.fn();
  readonly #settings: MediaTrackSettings;

  constructor(kind: 'video' | 'audio', settings: MediaTrackSettings = {}) {
    super();
    this.kind = kind;
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
    return this.#tracks.filter((track) => track.kind === 'video');
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'audio');
  }
}

const asStream = (stream: FakeMediaStream) => stream as unknown as MediaStream;

describe('acquireCameraSource', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('acquires the camera video-only, snapshots track settings, and releases when deactivated', async () => {
    const realStream = makeRealCameraStream();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(realStream);
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });

    const stream = context.cameraStream.get();
    expect(stream).toBe(realStream);
    expect(stream!.getVideoTracks().length).toBeGreaterThan(0);

    const tracks = state.cameraTracks.get();
    expect(tracks?.width).toBe(640);
    expect(tracks?.height).toBe(480);
    expect(tracks?.frameRate).toBeGreaterThan(0);

    const acquired = stream!.getTracks();
    state.cameraActive.set(false);

    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('idle');
      expect(context.cameraStream.get()).toBeUndefined();
    });
    expect(state.cameraTracks.get()).toBeUndefined();
    for (const track of acquired) expect(track.readyState).toBe('ended');
  });

  it('passes an exact device-id constraint to getUserMedia', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack('video')]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state } = setupAcquire();

    state.videoInputDeviceId.set('cam-1');
    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'cam-1' } }, audio: false });
    });
  });

  it('discards a stale acquire when the device id changes mid-flight', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { state, context } = setupAcquire();

    state.videoInputDeviceId.set('cam-1');
    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    state.videoInputDeviceId.set('cam-2');
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    const staleStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId: 'cam-1' })]);
    const freshStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId: 'cam-2' })]);

    second.resolve(asStream(freshStream));
    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
      expect(context.cameraStream.get()).toBe(asStream(freshStream));
    });

    // The stale acquire resolves after the switch: its tracks must be
    // stopped and the fresh stream left untouched.
    first.resolve(asStream(staleStream));
    await vi.waitFor(() => {
      for (const track of staleStream.getTracks()) expect(track.stop).toHaveBeenCalled();
    });
    expect(context.cameraStream.get()).toBe(asStream(freshStream));
    expect(state.cameraTracks.get()?.deviceId).toBe('cam-2');
    for (const track of freshStream.getTracks()) expect(track.stop).not.toHaveBeenCalled();
  });

  it('maps NotAllowedError to denied and consumes the intent', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError')
    );
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('denied');
    });
    expect(state.publishError.get()).toBeUndefined();
    expect(context.cameraStream.get()).toBeUndefined();
    // The request was answered (with a refusal): the intent slot returns
    // to false so the next true write is a real rising edge, and 'denied'
    // survives for the UI's blocked messaging.
    await vi.waitFor(() => {
      expect(state.cameraActive.get()).toBe(false);
    });
    expect(state.cameraState.get()).toBe('denied');
  });

  it('re-acquires on the next activation after a denial — one-click retry', async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'))
      .mockResolvedValueOnce(asStream(new FakeMediaStream([new FakeMediaStreamTrack('video')])));
    const { state } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.cameraActive.get()).toBe(false);
    });

    // Permission has been granted in browser settings; the same toggle
    // gesture must attempt acquisition again.
    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('maps other acquisition failures to idle + a capture publishError, consuming the intent', async () => {
    const failure = new Error('device exploded');
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(failure);
    const { state } = setupAcquire();

    state.cameraActive.set(true);

    await vi.waitFor(() => {
      expect(state.publishError.get()).toBeDefined();
    });
    expect(state.publishError.get()).toMatchObject({ code: 'capture', message: 'device exploded', cause: failure });
    expect(state.cameraState.get()).toBe('idle');
    // A failed acquisition consumes the intent like denied/ended do — a
    // NotReadable camera must not hold the mic's OR-gate hot or block the
    // one-click retry.
    await vi.waitFor(() => {
      expect(state.cameraActive.get()).toBe(false);
    });

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });
  });

  it('clears a stale capture error when a fresh acquisition starts', async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValueOnce(new Error('camera busy'))
      .mockResolvedValueOnce(asStream(new FakeMediaStream([new FakeMediaStreamTrack('video')])));
    const { state } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.publishError.get()).toMatchObject({ code: 'capture' });
    });

    // The retry supersedes the stale failure — a recovered source must not
    // keep reporting an obsolete capture error through the media surface.
    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
    });
    expect(state.publishError.get()).toBeUndefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('releases the stream and lands in ended when the track ends outside our control', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const stream = new FakeMediaStream([videoTrack]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
    });

    videoTrack.dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('ended');
    });
    expect(context.cameraStream.get()).toBeUndefined();
    expect(state.cameraTracks.get()).toBeUndefined();
    expect(videoTrack.stop).toHaveBeenCalled();
    // Intent consumed: the pipeline terminated on its own, and 'ended'
    // survives the release for the UI.
    await vi.waitFor(() => {
      expect(state.cameraActive.get()).toBe(false);
    });
    expect(state.cameraState.get()).toBe('ended');
  });

  it('stops the owned stream on destroy', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const stream = new FakeMediaStream([videoTrack]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context, reactor } = setupAcquire();

    state.cameraActive.set(true);
    await vi.waitFor(() => {
      expect(state.cameraState.get()).toBe('active');
    });

    reactor.destroy();

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(context.cameraStream.get()).toBeUndefined();
  });
});
