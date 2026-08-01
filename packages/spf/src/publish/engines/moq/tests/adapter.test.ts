import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoqtTransport } from '../../../../network/moqt/session';
import { createMoqtSession } from '../../../../network/moqt/session';
import { createTransportPair, type TransportPair } from '../../../../network/moqt/tests/helpers/transport-pair';
import type { ConnectPublishTransport } from '../../../session/publish-session';
import { MoqPublishMediaMixin, type MoqPublishMediaOptions } from '../adapter';

/**
 * EventTarget base so the adapter's event bridge has a `dispatchEvent` to
 * land on — the same seam a real media host (e.g. `HTMLVideoElementHost`)
 * provides.
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
  media.engine.state.captureStatus.set('active');
  return media;
}

/** A subscribe-side peer accepting every PUBLISH, so sessions can go live. */
function makeAcceptingPeer(pair: TransportPair) {
  const peer = createMoqtSession(pair.server, {
    callbacks: { onIncomingPublish: (_publish, respond) => respond.accept() },
  });
  disposals.push(() => peer.destroy());
  return peer;
}

/** Drive the engine's real session to `live` by offering an accepted track. */
async function driveLive(media: TestPublishMedia): Promise<void> {
  const session = await vi.waitFor(() => {
    const actor = media.engine.context.publishSessionActor.get();
    const current = actor?.snapshot.get().context.session;
    expect(current).toBeDefined();
    return current!;
  });
  session.publishTrack({ trackNamespace: ['live', 'abc123'], trackName: 'video' });
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

function makeFakeCameraStream() {
  return new FakeMediaStream([
    new FakeMediaStreamTrack('video', { deviceId: 'cam-1', width: 640, height: 480 }),
    new FakeMediaStreamTrack('audio', { deviceId: 'mic-1' }),
  ]);
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
    const stream = makeFakeCameraStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(asStream(stream));
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

    media.captureSource = 'camera';

    await vi.waitFor(() => {
      expect(media.captureState).toBe('active');
    });
    expect(media.captureStream).toBe(asStream(stream));
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

    media.captureSource = null;
    await vi.waitFor(() => {
      expect(media.captureState).toBe('idle');
      expect(media.captureStream).toBeNull();
    });
    expect(events.capturesourcechange).toBe(2);
    expect(events.capturestreamchange).toBe(2);
  });

  it('re-acquires the camera when videoInputDeviceId changes', async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockImplementation(async () => asStream(makeFakeCameraStream()));
    const media = makeMedia();

    media.captureSource = 'camera';
    await vi.waitFor(() => {
      expect(media.captureState).toBe('active');
    });

    const devicesChanged = vi.fn();
    media.addEventListener('capturedeviceschange', devicesChanged);
    media.videoInputDeviceId = 'cam-2';

    await vi.waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: { deviceId: { exact: 'cam-2' } }, audio: true });
    expect(media.engine.state.captureSource.get()).toEqual({ kind: 'camera', videoDeviceId: 'cam-2' });
    expect(media.videoInputDeviceId).toBe('cam-2');
    // Selections travel on the devices event; store slices re-read them there.
    expect(devicesChanged).toHaveBeenCalled();
  });

  it('mirrors the capture stream into an attached preview element', async () => {
    const realStream = makeRealCameraStream();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(realStream);
    const media = makeMedia();
    const preview = document.createElement('video');
    vi.spyOn(preview, 'play').mockResolvedValue(undefined);

    media.attach(preview);
    expect(media.engine.context.previewElement.get()).toBe(preview);

    media.captureSource = 'camera';
    await vi.waitFor(() => {
      expect(media.captureState).toBe('active');
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
    media.engine.state.captureStatus.set('active');
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
    makeAcceptingPeer(pair);
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
    await driveLive(media);
    await expect(retry).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(media.publishError).toBeNull();
  });

  it('unpublish() then publish() after a session error starts a fresh session', async () => {
    const pair = createTransportPair();
    makeAcceptingPeer(pair);
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
    await driveLive(media);
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
