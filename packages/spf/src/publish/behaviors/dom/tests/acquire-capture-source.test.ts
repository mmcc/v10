import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import {
  type AcquireCaptureSourceContext,
  type AcquireCaptureSourceState,
  acquireCaptureSource,
} from '../acquire-capture-source';

function makeState(initial: AcquireCaptureSourceState = {}): StateSignals<AcquireCaptureSourceState> {
  return {
    captureSource: signal(initial.captureSource),
    captureStatus: signal(initial.captureStatus ?? 'idle'),
    captureTracks: signal(initial.captureTracks),
    publishError: signal(initial.publishError),
  };
}

function makeContext(initial: AcquireCaptureSourceContext = {}): ContextSignals<AcquireCaptureSourceContext> {
  return {
    captureStream: signal(initial.captureStream),
  };
}

const disposals: (() => void)[] = [];

function setupAcquire() {
  const state = makeState();
  const context = makeContext();
  const reactor = acquireCaptureSource.setup({ state, context });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A real `MediaStream` with real video + audio tracks, built without any
 * capture device: canvas capture for video, a WebAudio destination for
 * audio. Real tracks give real `getSettings()` / `stop()` / `'ended'`
 * semantics in headless Chromium, where no fake camera exists.
 */
function makeRealCameraStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.getContext('2d')!.fillRect(0, 0, 10, 10);
  const stream = canvas.captureStream(30);
  const audioContext = new AudioContext();
  disposals.push(() => void audioContext.close().catch(() => undefined));
  for (const track of audioContext.createMediaStreamDestination().stream.getAudioTracks()) {
    stream.addTrack(track);
  }
  return stream;
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

  addTrack(track: FakeMediaStreamTrack): void {
    this.#tracks.push(track);
  }
}

const asStream = (stream: FakeMediaStream) => stream as unknown as MediaStream;

describe('acquireCaptureSource', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('acquires the camera, snapshots track settings, and releases on deselect', async () => {
    const realStream = makeRealCameraStream();
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(realStream);
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });

    const stream = context.captureStream.get();
    expect(stream).toBe(realStream);
    expect(stream!.getVideoTracks().length).toBeGreaterThan(0);
    expect(stream!.getAudioTracks().length).toBeGreaterThan(0);

    const tracks = state.captureTracks.get();
    expect(tracks?.video?.width).toBe(640);
    expect(tracks?.video?.height).toBe(480);
    expect(tracks?.video?.frameRate).toBeGreaterThan(0);
    expect(tracks?.audio?.sampleRate).toBeGreaterThan(0);
    expect(tracks?.audio?.channelCount).toBeGreaterThan(0);

    const acquired = stream!.getTracks();
    state.captureSource.set(undefined);

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('idle');
      expect(context.captureStream.get()).toBeUndefined();
    });
    expect(state.captureTracks.get()).toBeUndefined();
    for (const track of acquired) expect(track.readyState).toBe('ended');
  });

  it('passes exact device-id constraints to getUserMedia', async () => {
    const stream = new FakeMediaStream([new FakeMediaStreamTrack('video'), new FakeMediaStreamTrack('audio')]);
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state } = setupAcquire();

    state.captureSource.set({ kind: 'camera', videoDeviceId: 'cam-1', audioDeviceId: 'mic-1' });

    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledWith({
        video: { deviceId: { exact: 'cam-1' } },
        audio: { deviceId: { exact: 'mic-1' } },
      });
    });
  });

  it('discards a stale acquire when the selection changes mid-flight', async () => {
    const first = deferred<MediaStream>();
    const second = deferred<MediaStream>();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'camera', videoDeviceId: 'cam-1' });
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    state.captureSource.set({ kind: 'camera', videoDeviceId: 'cam-2' });
    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    const staleStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId: 'cam-1' })]);
    const freshStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId: 'cam-2' })]);

    second.resolve(asStream(freshStream));
    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
      expect(context.captureStream.get()).toBe(asStream(freshStream));
    });

    // The stale acquire resolves after the switch: its tracks must be
    // stopped and the fresh stream left untouched.
    first.resolve(asStream(staleStream));
    await vi.waitFor(() => {
      for (const track of staleStream.getTracks()) expect(track.stop).toHaveBeenCalled();
    });
    expect(context.captureStream.get()).toBe(asStream(freshStream));
    expect(state.captureTracks.get()?.video?.deviceId).toBe('cam-2');
    for (const track of freshStream.getTracks()) expect(track.stop).not.toHaveBeenCalled();
  });

  it.each(['NotFoundError', 'OverconstrainedError'])(
    'retries camera capture video-only when the audio input fails with %s',
    async (errorName) => {
      const videoOnly = new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId: 'cam-1' })]);
      const getUserMedia = vi
        .spyOn(navigator.mediaDevices, 'getUserMedia')
        .mockImplementation(async (constraints?: MediaStreamConstraints) => {
          if (constraints?.audio) throw new DOMException('Requested device not found', errorName);
          return asStream(videoOnly);
        });
      const { state, context } = setupAcquire();

      state.captureSource.set({ kind: 'camera', videoDeviceId: 'cam-1' });

      // A mic-less machine must not kill camera capture: the acquire
      // retries video-only and goes active without audio facts.
      await vi.waitFor(() => {
        expect(state.captureStatus.get()).toBe('active');
      });
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: 'cam-1' } }, audio: false });
      expect(context.captureStream.get()).toBe(asStream(videoOnly));
      expect(state.captureTracks.get()?.video).toBeDefined();
      expect(state.captureTracks.get()?.audio).toBeUndefined();
      expect(state.publishError.get()).toBeUndefined();
    }
  );

  it('still surfaces a video-side NotFoundError after the video-only retry', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('Requested device not found', 'NotFoundError')
    );
    const { state } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });

    await vi.waitFor(() => {
      expect(state.publishError.get()).toMatchObject({ code: 'capture' });
    });
    expect(state.captureStatus.get()).toBe('idle');
  });

  it('maps NotAllowedError to denied', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError')
    );
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('denied');
    });
    expect(state.publishError.get()).toBeUndefined();
    expect(context.captureStream.get()).toBeUndefined();
  });

  it('maps other acquisition failures to idle + a capture publishError', async () => {
    const failure = new Error('device exploded');
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(failure);
    const { state } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });

    await vi.waitFor(() => {
      expect(state.publishError.get()).toBeDefined();
    });
    expect(state.publishError.get()).toMatchObject({ code: 'capture', message: 'device exploded', cause: failure });
    expect(state.captureStatus.get()).toBe('idle');
  });

  it('releases the stream and lands in ended when a track ends outside our control', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const audioTrack = new FakeMediaStreamTrack('audio');
    const stream = new FakeMediaStream([videoTrack, audioTrack]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });
    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });

    videoTrack.dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('ended');
    });
    expect(context.captureStream.get()).toBeUndefined();
    expect(state.captureTracks.get()).toBeUndefined();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  it('merges a microphone track into an audio-less screen share', async () => {
    const displayStream = new FakeMediaStream([new FakeMediaStreamTrack('video')]);
    const micTrack = new FakeMediaStreamTrack('audio', { deviceId: 'mic-1' });
    const micStream = new FakeMediaStream([micTrack]);
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(micStream));
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'screen', audioDeviceId: 'mic-1' });

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-1' } } });
    expect(context.captureStream.get()).toBe(asStream(displayStream));
    expect(displayStream.getAudioTracks()).toEqual([micTrack]);
    expect(state.captureTracks.get()?.audio?.deviceId).toBe('mic-1');
  });

  it('keeps the display audio track when the screen share already has audio', async () => {
    const displayStream = new FakeMediaStream([new FakeMediaStreamTrack('video'), new FakeMediaStreamTrack('audio')]);
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const { state } = setupAcquire();

    state.captureSource.set({ kind: 'screen' });

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('publishes a video-only screen share when the mic merge fails', async () => {
    const displayStream = new FakeMediaStream([new FakeMediaStreamTrack('video')]);
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(new DOMException('no mic', 'NotFoundError'));
    const { state, context } = setupAcquire();

    state.captureSource.set({ kind: 'screen' });

    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });
    expect(context.captureStream.get()).toBe(asStream(displayStream));
    expect(state.captureTracks.get()?.video).toBeDefined();
    expect(state.captureTracks.get()?.audio).toBeUndefined();
    expect(state.publishError.get()).toBeUndefined();
  });

  it('stops the owned stream on destroy', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const stream = new FakeMediaStream([videoTrack]);
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
    const { state, context, reactor } = setupAcquire();

    state.captureSource.set({ kind: 'camera' });
    await vi.waitFor(() => {
      expect(state.captureStatus.get()).toBe('active');
    });

    reactor.destroy();

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(context.captureStream.get()).toBeUndefined();
  });
});
