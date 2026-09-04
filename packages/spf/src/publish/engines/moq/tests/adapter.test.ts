import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { MoqtTransport } from '../../../../network/moqt/session';
import { createMoqtSession } from '../../../../network/moqt/session';
import { solicitNamespace } from '../../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair, type TransportPair } from '../../../../network/moqt/tests/helpers/transport-pair';
import type { ConnectPublishTransport } from '../../../session/publish-session';
import { MoqPublishMediaMixin, type MoqPublishMediaOptions } from '../adapter';

/**
 * EventTarget base so the adapter's event bridge has a `dispatchEvent` to land on — the same seam a real media host
 * (e.g. `HTMLVideoElementHost`) provides.
 */
class TestPublishMedia extends MoqPublishMediaMixin(EventTarget) {}

const disposals: (() => void)[] = [];

function makeMedia(options?: MoqPublishMediaOptions): TestPublishMedia {
  const media = new TestPublishMedia(options);

  disposals.push(() => media.destroy());
  return media;
}

/** Keeps the session actor `connecting` forever — tests drive sessionStatus. */
const pendingConnect: ConnectPublishTransport = () => ({
  transport: {} as MoqtTransport,
  ready: new Promise<never>(() => {}),
});

/** Media with publish() preconditions met and the transport seam injected. */
function makePublishableMedia(connectTransport: ConnectPublishTransport = pendingConnect): TestPublishMedia {
  const media = makeMedia({ engineConfig: { connectTransport } });

  media.publishEndpoint = 'https://relay.example.com/moq';
  media.publishNamespace = 'live/abc123';
  media.engine.state.cameraState.set('active');
  return media;
}

/** A subscribe-side peer completing SETUP, so sessions can come up. */
function makePeer(pair: TransportPair) {
  const peer = createMoqtSession(pair.server, {});

  disposals.push(() => peer.destroy());
  return peer;
}

/**
 * Drive the engine's real session to `live` by registering a servable track (normally `setupTrackPublishers`' job,
 * gated on encodings these tests do not produce) and soliciting the namespace from the peer side — announce-and-serve's
 * liveness trigger.
 */
async function driveLive(media: TestPublishMedia, pair: TransportPair): Promise<void> {
  const session = await vi.waitFor(() => {
    const actor = media.engine.context.publishSessionActor.get();
    const current = actor?.snapshot.get().context.session;

    expect(current).toBeDefined();
    return current!;
  });

  session.registerTrack({ trackNamespace: ['live', 'abc123'], trackName: 'catalog' });
  void solicitNamespace(pair.server, []);
  await vi.waitFor(() => {
    expect(media.publishState).toBe('live');
  });
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

function makeFakeVideoStream(deviceId = 'cam-1') {
  return new FakeMediaStream([new FakeMediaStreamTrack('video', { deviceId, width: 640, height: 480 })]);
}

function makeFakeAudioStream(deviceId = 'mic-1') {
  return new FakeMediaStream([new FakeMediaStreamTrack('audio', { deviceId })]);
}

/**
 * Camera and mic both call `getUserMedia`, distinguished only by which of `video`/`audio` is truthy in the constraints
 * — dispatch on that so each pipeline gets its own stream instead of sharing one (which would make releasing the camera
 * also stop the mic's track).
 */
function mockGetUserMedia(
  videoStream: FakeMediaStream = makeFakeVideoStream(),
  audioStream: FakeMediaStream = makeFakeAudioStream()
) {
  return vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints) => {
    if (constraints?.audio) return asStream(audioStream);

    return asStream(videoStream);
  });
}

/** A real `MediaStream` (canvas capture) so DOM sinks like `srcObject` accept it. */
function makeRealCameraStream(): MediaStream {
  const canvas = document.createElement('canvas');

  canvas.width = 320;
  canvas.height = 240;
  canvas.getContext('2d')!.fillRect(0, 0, 10, 10);
  return canvas.captureStream(30);
}

describe('MoqPublishMediaMixin', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('composes publishEndpoint + publishNamespace into state.endpoint', () => {
    const media = makeMedia();

    media.publishNamespace = 'live/abc123';
    // Namespace alone is not an endpoint.
    expect(media.engine.state.endpoint.get()).toBeUndefined();

    media.publishEndpoint = 'https://relay.example.com/moq';
    expect(media.engine.state.endpoint.get()).toEqual({
      url: 'https://relay.example.com/moq',
      namespace: ['live', 'abc123'],
    });
    expect(media.publishEndpoint).toBe('https://relay.example.com/moq');
    expect(media.publishNamespace).toBe('live/abc123');

    media.publishEndpoint = '';
    expect(media.engine.state.endpoint.get()).toBeUndefined();
  });

  it('carries publishAuthToken into state.endpoint only when set', () => {
    const media = makeMedia();

    media.publishEndpoint = 'https://relay.example.com/moq';
    media.publishNamespace = 'live/abc123';
    expect(media.engine.state.endpoint.get()).not.toHaveProperty('authToken');

    media.publishAuthToken = 'secret-token';
    expect(media.engine.state.endpoint.get()).toEqual({
      url: 'https://relay.example.com/moq',
      namespace: ['live', 'abc123'],
      authToken: 'secret-token',
    });

    media.publishAuthToken = '';
    expect(media.engine.state.endpoint.get()).not.toHaveProperty('authToken');
  });

  it('bridges capture facts to contract events through the real engine', async () => {
    vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([
      { deviceId: 'cam-1', kind: 'videoinput', label: 'Fake camera', groupId: 'g1' } as MediaDeviceInfo,
      { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Fake speaker', groupId: 'g1' } as MediaDeviceInfo,
    ]);
    const stream = makeFakeVideoStream();

    mockGetUserMedia(stream);
    const media = makeMedia();

    const events: Record<string, number> = {};
    const count = (type: string) => {
      events[type] = 0;
      media.addEventListener(type, () => {
        events[type] = (events[type] ?? 0) + 1;
      });
    };

    count('capturesourcechange');
    count('capturestatechange');
    count('capturestreamchange');
    count('capturedeviceschange');
    count('capturetogglechange');

    // Device enumeration runs at engine construction; the bridge fires
    // once the devices land (audiooutput filtered away).
    await vi.waitFor(() => {
      expect(events.capturedeviceschange).toBeGreaterThan(0);
    });
    expect(media.captureDevices).toEqual([{ deviceId: 'cam-1', kind: 'videoinput', label: 'Fake camera' }]);

    media.cameraActive = true;

    await vi.waitFor(() => {
      expect(media.cameraState).toBe('active');
    });
    expect(media.cameraStream).toBe(asStream(stream));
    expect(events.capturesourcechange).toBe(1);
    // acquiring → active
    expect(events.capturestatechange).toBeGreaterThanOrEqual(2);
    expect(events.capturestreamchange).toBe(1);

    media.cameraMuted = true;
    await vi.waitFor(() => {
      expect(events.capturetogglechange).toBe(1);
    });
    expect(media.cameraMuted).toBe(true);
    await vi.waitFor(() => {
      expect(stream.getVideoTracks()[0]!.enabled).toBe(false);
    });

    media.cameraActive = false;
    await vi.waitFor(() => {
      expect(media.cameraState).toBe('idle');
      expect(media.cameraStream).toBeNull();
    });
    expect(events.capturesourcechange).toBe(2);
    expect(events.capturestreamchange).toBe(2);
  });

  it('re-acquires only the camera when videoInputDeviceId changes — the mic is untouched', async () => {
    const getUserMedia = mockGetUserMedia();
    const media = makeMedia();

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.cameraState).toBe('active');
      // Camera being active is enough to gate the mic pipeline on too.
      expect(media.engine.state.micState.get()).toBe('active');
    });
    const cameraCallsSoFar = getUserMedia.mock.calls.filter((call) => !call[0]?.audio).length;

    const devicesChanged = vi.fn();

    media.addEventListener('capturedeviceschange', devicesChanged);
    media.videoInputDeviceId = 'cam-2';

    await vi.waitFor(() => {
      expect(getUserMedia.mock.calls.filter((call) => !call[0]?.audio).length).toBe(cameraCallsSoFar + 1);
    });
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: 'cam-2' } }, audio: false });
    expect(media.engine.state.videoInputDeviceId.get()).toBe('cam-2');
    expect(media.videoInputDeviceId).toBe('cam-2');
    // Selections travel on the devices event; store slices re-read them there.
    expect(devicesChanged).toHaveBeenCalled();
    // The mic pipeline never re-fires for a camera device-id change — the
    // confirmed defect this contract redesign fixes.
    expect(getUserMedia.mock.calls.filter((call) => call[0]?.audio).length).toBe(1);
  });

  it('exposes the mic lifecycle and fires capturestatechange when it moves', async () => {
    const audioStream = makeFakeAudioStream();

    mockGetUserMedia(makeFakeVideoStream(), audioStream);
    const media = makeMedia();

    expect(media.micState).toBe('idle');
    const stateChanged = vi.fn();

    media.addEventListener('capturestatechange', stateChanged);

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.micState).toBe('active');
    });

    // A mic dying mid-broadcast must be observable on the contract — the
    // only way a UI can say why a live broadcast has no sound. The camera
    // keeps capturing, so only the mic third of the bridge key moves.
    const callsBefore = stateChanged.mock.calls.length;

    audioStream.getTracks()[0]!.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => {
      expect(media.micState).toBe('ended');
    });
    expect(media.cameraState).toBe('active');
    expect(stateChanged.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('drives an audio-only surface: micActive alone acquires the mic and fires capturesourcechange', async () => {
    const getUserMedia = mockGetUserMedia();
    const media = makeMedia();
    const sourceChanged = vi.fn();

    media.addEventListener('capturesourcechange', sourceChanged);

    expect(media.micActive).toBe(false);
    media.micActive = true;

    await vi.waitFor(() => {
      expect(media.micState).toBe('active');
    });
    // No video pipeline was touched — the voice-only page's permission
    // prompt says "microphone", never "camera + microphone" (issue #26).
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(media.cameraState).toBe('idle');
    expect(media.screenShareState).toBe('idle');
    expect(sourceChanged).toHaveBeenCalled();

    media.micActive = false;
    await vi.waitFor(() => {
      expect(media.micState).toBe('idle');
    });
  });

  it('publish() accepts an active microphone as its capture precondition — audio-only publish', async () => {
    mockGetUserMedia();
    const media = makeMedia({ engineConfig: { connectTransport: pendingConnect } });

    media.publishEndpoint = 'https://relay.example.com/moq';
    media.publishNamespace = 'live/abc123';

    media.micActive = true;
    await vi.waitFor(() => {
      expect(media.micState).toBe('active');
    });

    const pending = media.publish();

    expect(media.engine.state.publishActivated.get()).toBe(true);
    await vi.waitFor(() => {
      expect(media.publishState).toBe('connecting');
    });
    media.engine.state.sessionStatus.set('live');
    await expect(pending).resolves.toBeUndefined();
  });

  it('drives the screen-share surface: intent, stream, preview source, and events', async () => {
    const screenStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { width: 1920 })]);

    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(screenStream));
    mockGetUserMedia();
    const media = makeMedia();

    const sourceChanged = vi.fn();

    media.addEventListener('capturesourcechange', sourceChanged);

    media.screenShareActive = true;
    await vi.waitFor(() => {
      expect(media.screenShareState).toBe('active');
    });
    expect(media.screenShareActive).toBe(true);
    expect(media.screenShareStream).toBe(asStream(screenStream));
    expect(media.cameraStream).toBeNull();
    expect(sourceChanged).toHaveBeenCalledTimes(1);

    expect(media.previewSource).toBe('camera');
    media.previewSource = 'screen';
    expect(media.previewSource).toBe('screen');
    expect(media.engine.state.previewSource.get()).toBe('screen');

    media.screenShareActive = false;
    await vi.waitFor(() => {
      expect(media.screenShareState).toBe('idle');
      expect(media.screenShareStream).toBeNull();
    });
    expect(sourceChanged).toHaveBeenCalledTimes(2);
  });

  it('fires capturestreamchange when a slot stream is replaced, not only on presence changes', async () => {
    const first = makeFakeVideoStream('cam-1');
    const second = makeFakeVideoStream('cam-2');
    let currentVideo = first;

    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints) => {
      if (constraints?.audio) return asStream(makeFakeAudioStream());

      return asStream(currentVideo);
    });
    const media = makeMedia();
    const streamChanged = vi.fn();

    media.addEventListener('capturestreamchange', streamChanged);

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.cameraStream).toBe(asStream(first));
    });
    const callsAfterFirst = streamChanged.mock.calls.length;

    // A device switch re-acquires IN PLACE: the slot stays occupied but the
    // stream identity changes — meters holding the old tracks must be told.
    currentVideo = second;
    media.videoInputDeviceId = 'cam-2';
    await vi.waitFor(() => {
      expect(media.cameraStream).toBe(asStream(second));
    });
    expect(streamChanged.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('reads cameraActive false after a denial and re-attempts on the next set — one-click retry', async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const media = makeMedia();

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.cameraState).toBe('denied');
    });
    // The engine consumed the intent — the adapter surface must agree, or
    // toggles/guards reading cameraActive would block the retry.
    await vi.waitFor(() => {
      expect(media.cameraActive).toBe(false);
    });

    const cameraCalls = () => getUserMedia.mock.calls.filter((call) => call[0]?.video).length;
    const callsAfterDenial = cameraCalls();

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(cameraCalls()).toBe(callsAfterDenial + 1);
    });
  });

  it('mirrors the capture stream into an attached preview element', async () => {
    const realStream = makeRealCameraStream();

    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(realStream);
    const media = makeMedia();
    const preview = document.createElement('video');

    vi.spyOn(preview, 'play').mockResolvedValue(undefined);

    media.attach(preview);
    expect(media.engine.context.previewElement.get()).toBe(preview);

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.cameraState).toBe('active');
    });
    await vi.waitFor(() => {
      expect(preview.srcObject).toBe(realStream);
    });
    expect(preview.muted).toBe(true);

    media.detach();
    expect(media.engine.context.previewElement.get()).toBeUndefined();
    await vi.waitFor(() => {
      expect(preview.srcObject).toBeNull();
    });
  });

  it('publish() records intent and resolves when the session goes live', async () => {
    const media = makePublishableMedia();

    expect(media.publishState).toBe('idle');
    const pending = media.publish();

    expect(media.engine.state.publishActivated.get()).toBe(true);
    expect(media.publishStartedAt).toBeNaN();

    // Let the real session behavior claim its status writes first.
    await vi.waitFor(() => {
      expect(media.publishState).toBe('connecting');
    });
    media.engine.state.sessionStatus.set('live');
    await expect(pending).resolves.toBeUndefined();
  });

  it('publish() rejects with the engine publishError when the session errors', async () => {
    const media = makePublishableMedia();

    const pending = media.publish();

    await vi.waitFor(() => {
      expect(media.publishState).toBe('connecting');
    });
    media.engine.state.publishError.set({ code: 'transport', message: 'relay unreachable' });
    media.engine.state.sessionStatus.set('error');
    await expect(pending).rejects.toThrow('relay unreachable');
    expect(media.publishError).toEqual({ code: 3, message: 'relay unreachable' });
  });

  it('publish() rejects when unpublish() abandons the attempt', async () => {
    const media = makePublishableMedia();

    const pending = media.publish();

    media.unpublish();
    expect(media.engine.state.publishActivated.get()).toBe(false);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it('publish() rejects immediately while its preconditions are unmet, then proceeds', async () => {
    const media = makeMedia({ engineConfig: { connectTransport: pendingConnect } });

    // No endpoint: reject without recording publish intent.
    await expect(media.publish()).rejects.toThrow(/publishEndpoint/);
    expect(media.engine.state.publishActivated.get()).toBe(false);

    // Endpoint but no active capture: same play()-like rejection.
    media.publishEndpoint = 'https://relay.example.com/moq';
    media.publishNamespace = 'live/abc123';
    await expect(media.publish()).rejects.toThrow(/active capture/);
    expect(media.engine.state.publishActivated.get()).toBe(false);

    // Once capture is active, the same call proceeds to a session attempt.
    media.engine.state.cameraState.set('active');
    const pending = media.publish();

    expect(media.engine.state.publishActivated.get()).toBe(true);
    await vi.waitFor(() => {
      expect(media.publishState).toBe('connecting');
    });
    media.engine.state.sessionStatus.set('live');
    await expect(pending).resolves.toBeUndefined();
  });

  it('publish() after a session error reconnects and settles on the new outcome', async () => {
    const pair = createTransportPair();

    makePeer(pair);
    let attempts = 0;
    const media = makePublishableMedia(() => {
      attempts += 1;

      if (attempts === 1) throw new Error('connect refused');

      return { transport: pair.client, ready: Promise.resolve() };
    });

    await expect(media.publish()).rejects.toThrow('connect refused');
    expect(media.publishState).toBe('error');

    // Retry while publishActivated is still true: it must not instantly
    // reject with the stale error — it cycles the gate, reconnects, and
    // settles on the second attempt's outcome.
    const retry = media.publish();

    await driveLive(media, pair);
    await expect(retry).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(media.publishError).toBeNull();
  });

  it('unpublish() then publish() after a session error starts a fresh session', async () => {
    const pair = createTransportPair();

    makePeer(pair);
    let attempts = 0;
    const media = makePublishableMedia(() => {
      attempts += 1;

      if (attempts === 1) throw new Error('connect refused');

      return { transport: pair.client, ready: Promise.resolve() };
    });

    await expect(media.publish()).rejects.toThrow('connect refused');
    media.unpublish();

    // The stale sticky 'error' must not settle the new attempt.
    const retry = media.publish();

    await driveLive(media, pair);
    await expect(retry).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('maps engine session status onto the media publish state and fires publishstatechange', async () => {
    const media = makeMedia();
    const publishStateChanges: string[] = [];

    media.addEventListener('publishstatechange', () => {
      publishStateChanges.push(media.publishState);
    });

    media.engine.state.sessionStatus.set('connecting');
    await vi.waitFor(() => {
      expect(publishStateChanges).toEqual(['connecting']);
    });

    // ready collapses onto connecting — no event, no change.
    media.engine.state.sessionStatus.set('ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(publishStateChanges).toEqual(['connecting']);

    media.engine.state.sessionStatus.set('live');
    await vi.waitFor(() => {
      expect(publishStateChanges).toEqual(['connecting', 'live']);
    });
    expect(media.publishStartedAt).not.toBeNaN();

    media.engine.state.sessionStatus.set('draining');
    await vi.waitFor(() => {
      expect(publishStateChanges).toEqual(['connecting', 'live', 'stopping']);
    });
    // Held through 'stopping' so session timers keep showing the elapsed
    // time while the shutdown drains.
    expect(media.publishStartedAt).not.toBeNaN();

    media.engine.state.sessionStatus.set('closed');
    await vi.waitFor(() => {
      expect(media.publishState).toBe('idle');
    });
    expect(media.publishStartedAt).toBeNaN();
  });

  it('fires publishstatechange when an error lands while the session stays live', async () => {
    const media = makeMedia();

    media.engine.state.sessionStatus.set('live');
    await vi.waitFor(() => {
      expect(media.publishState).toBe('live');
    });

    const seen: (typeof media.publishError)[] = [];

    media.addEventListener('publishstatechange', () => {
      seen.push(media.publishError);
    });

    // Encoder and track failures surface without moving sessionStatus —
    // consumers re-read publishError only on this event, so an error-only
    // change must dispatch too.
    media.engine.state.publishError.set({ code: 'encode', message: 'encoder died' });
    await vi.waitFor(() => {
      expect(seen).toEqual([{ code: 2, message: 'encoder died' }]);
    });
    expect(media.publishState).toBe('live');
  });

  it('does not dispatch publishstatechange for errors while idle', async () => {
    const media = makeMedia();
    const events: string[] = [];

    media.addEventListener('publishstatechange', () => events.push(media.publishState));

    // Capture/probe failures land before any publish attempt: they reject
    // publish() directly and must not surface on the publish event.
    media.engine.state.publishError.set({ code: 'capture', message: 'permission denied' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
  });

  it('dispatches once when a failure moves the session and sets the error together', async () => {
    const media = makeMedia();

    media.engine.state.sessionStatus.set('live');
    await vi.waitFor(() => {
      expect(media.publishState).toBe('live');
    });

    const events: string[] = [];

    media.addEventListener('publishstatechange', () => events.push(media.publishState));

    // open-publish-session writes both signals in one flush on a transport
    // failure — the status bridge carries the event; a second dispatch from
    // the error bridge would double it.
    media.engine.state.publishError.set({ code: 'transport', message: 'relay gone' });
    media.engine.state.sessionStatus.set('error');
    await vi.waitFor(() => {
      expect(events).toEqual(['error']);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['error']);
  });

  it('fires publishstatsupdate on every stats transition, including the reset to undefined', async () => {
    const media = makeMedia();
    const seen: (number | null)[] = [];

    media.addEventListener('publishstatsupdate', () => {
      seen.push(media.publishStats?.bytesSent ?? null);
    });

    media.engine.state.publishStats.set({
      encodedFps: 30,
      videoBitrate: 2_500_000,
      audioBitrate: 128_000,
      droppedFrames: 0,
      droppedGroups: 0,
      bytesSent: 1024,
      subscriberCount: Number.NaN,
    });
    await vi.waitFor(() => {
      expect(seen).toEqual([1024]);
    });

    // The teardown reset must also dispatch — consumers reading
    // `publishStats` on the event need to observe stats going away.
    media.engine.state.publishStats.set(undefined);
    await vi.waitFor(() => {
      expect(seen).toEqual([1024, null]);
    });
    expect(media.publishStats).toBeNull();
  });
});
