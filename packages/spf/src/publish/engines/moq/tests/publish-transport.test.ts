import { afterEach, describe, expect, it, vi } from 'vitest';
import { effect } from '../../../../core/signals/effect';
import { toLocFrame } from '../../../../media/moq/loc';
import { applyMoqCatalogUpdate } from '../../../../media/moq/parse-catalog';
import { utf8Decode } from '../../../../network/moqt/bytes';
import type { MoqtObject } from '../../../../network/moqt/object-stream';
import { createMoqtSession } from '../../../../network/moqt/session';
import { createTransportPair } from '../../../../network/moqt/tests/helpers/transport-pair';
import { MoqPublishMediaMixin } from '../adapter';

/**
 * The full-pipeline proof: real capture (canvas + oscillator) → real
 * WebCodecs encode → the in-repo publish session over an in-memory
 * transport pair → the EXISTING subscribe driver on the far side.
 */
class TestPublishMedia extends MoqPublishMediaMixin(EventTarget) {}

const disposals: (() => void)[] = [];

function makeLiveCameraStream(): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext('2d')!;
  let hue = 0;
  const paint = setInterval(() => {
    hue = (hue + 7) % 360;
    context.fillStyle = `hsl(${hue}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  disposals.push(() => clearInterval(paint));
  const stream = canvas.captureStream(30);

  const audioContext = new AudioContext({ sampleRate: 48_000 });
  disposals.push(() => void audioContext.close().catch(() => undefined));
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  void audioContext.resume().catch(() => undefined);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

  return stream;
}

describe('MoqPublishMediaMixin transport (M3)', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('publishes catalog + LOC media to a subscribe session end to end', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(makeLiveCameraStream());

    const pair = createTransportPair();
    const publishes: string[] = [];
    const subscriber = createMoqtSession(pair.server, {
      unknownAliasTimeoutMs: 2000,
      callbacks: {
        onIncomingPublish: (publish, respond) => {
          publishes.push(publish.trackName);
          respond.accept();
        },
      },
    });
    disposals.push(() => subscriber.destroy());

    const media = new TestPublishMedia({
      engineConfig: {
        groupDurationSec: 0.5,
        connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
      },
    });
    disposals.push(() => media.destroy());

    const statuses: (string | undefined)[] = [];
    disposals.push(
      effect(() => {
        const status = media.engine.state.sessionStatus.get();
        if (statuses.at(-1) !== status) statuses.push(status);
      })
    );

    media.cameraActive = true;
    await vi.waitFor(() => {
      expect(media.cameraState).toBe('active');
    });

    media.publishEndpoint = 'https://relay.example.com/moq';
    media.publishNamespace = 'live/abc123';
    const published = media.publish();

    // The session offers every track; the subscriber accepts.
    await vi.waitFor(
      () => {
        expect(publishes).toContain('catalog');
        expect(publishes).toContain('video');
        expect(publishes).toContain('audio');
      },
      { timeout: 15_000 }
    );

    // publish() resolves once the session is live.
    await expect(published).resolves.toBeUndefined();
    expect(media.publishState).toBe('live');
    expect(media.publishStartedAt).not.toBeNaN();
    expect(statuses).toEqual(['idle', 'connecting', 'ready', 'live']);

    // Subscribe to the published tracks with the existing driver.
    const namespace = ['live', 'abc123'];
    const collect = (trackName: string) => {
      const objects: MoqtObject[] = [];
      const done: unknown[] = [];
      subscriber.subscribe(
        { trackNamespace: namespace, trackName },
        { onObject: (object) => objects.push(object), onDone: (info) => done.push(info) }
      );
      return { objects, done };
    };
    const catalog = collect('catalog');
    const video = collect('video');
    const audio = collect('audio');

    // ≥1 catalog object whose JSON round-trips through parse-catalog.
    await vi.waitFor(
      () => {
        expect(catalog.objects.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15_000 }
    );
    const parsed = applyMoqCatalogUpdate(undefined, utf8Decode(catalog.objects[0]!.payload), {
      catalogNamespace: namespace,
    });
    const names = parsed.tracks.map((track) => track.name);
    expect(names).toContain('video');
    expect(names).toContain('audio');
    expect(parsed.tracks.every((track) => track.packaging === 'loc' && track.isLive)).toBe(true);
    expect(parsed.tracks.find((track) => track.name === 'audio')?.codec).toBe('opus');

    // Real encoded media flows: several objects per track, LOC-extractable,
    // group 0 starting at a keyframe.
    await vi.waitFor(
      () => {
        expect(video.objects.length).toBeGreaterThanOrEqual(5);
        expect(audio.objects.length).toBeGreaterThanOrEqual(5);
      },
      { timeout: 20_000, interval: 250 }
    );
    const firstVideo = video.objects[0]!;
    expect(firstVideo.objectId).toBe(0);
    const firstFrame = toLocFrame(firstVideo)!;
    expect(firstFrame.isKey).toBe(true);
    expect(firstFrame.payload.length).toBeGreaterThan(0);
    // Keyframe cadence → group ids advance.
    await vi.waitFor(
      () => {
        expect(video.objects.at(-1)!.groupId).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15_000, interval: 250 }
    );
    // Audio publishes one group per frame with object id 0.
    expect(audio.objects.every((object) => object.objectId === 0)).toBe(true);
    expect(audio.objects[1]!.groupId).toBeGreaterThan(audio.objects[0]!.groupId);

    // Unpublish: PUBLISH_DONE reaches the subscriptions and the session
    // returns to idle.
    media.unpublish();
    await vi.waitFor(
      () => {
        expect(video.done.length).toBeGreaterThanOrEqual(1);
        expect(catalog.done.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 }
    );
    await vi.waitFor(() => {
      expect(media.publishState).toBe('idle');
    });
  }, 60_000);
});
