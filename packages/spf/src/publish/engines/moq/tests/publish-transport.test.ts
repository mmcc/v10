import { afterEach, describe, expect, it, vi } from 'vitest';
import { effect } from '../../../../core/signals/effect';
import { toLocFrame } from '../../../../media/moq/loc';
import { applyMoqCatalogUpdate } from '../../../../media/moq/parse-catalog';
import { utf8Decode } from '../../../../network/moqt/bytes';
import type { MoqtObject } from '../../../../network/moqt/object-stream';
import { createMoqtSession } from '../../../../network/moqt/session';
import { solicitNamespace } from '../../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair } from '../../../../network/moqt/tests/helpers/transport-pair';
import { MoqPublishMediaMixin } from '../adapter';

/**
 * The full-pipeline proof: real capture (canvas + oscillator) → real
 * WebCodecs encode → the in-repo publish session over an in-memory
 * transport pair → the EXISTING subscribe driver on the far side.
 *
 * Ingest is announce-and-serve (moq-relay 0.14.7), so the peer speaks
 * first: it solicits announces on a raw bidi stream (SUBSCRIBE_NAMESPACE
 * — the subscribe driver never initiates one), reads the publisher's
 * REQUEST_OK and NAMESPACE entry off it, then pulls each track with the
 * driver's ordinary SUBSCRIBEs — the publisher answers SUBSCRIBE_OK and
 * only then lets data flow for that track.
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
    const proactivePublishes: string[] = [];
    const subscriber = createMoqtSession(pair.server, {
      unknownAliasTimeoutMs: 2000,
      callbacks: {
        // Regression tripwire: moq-relay 0.14.7 removed PUBLISH ingest —
        // mirror its rejection so a slide back to the proactive-PUBLISH
        // model fails this test loudly (asserted empty at the end).
        onIncomingPublish: (publish, respond) => {
          proactivePublishes.push(publish.trackName);
          respond.reject(400, 'PUBLISH is not supported');
        },
      },
    });
    disposals.push(() => subscriber.destroy());

    const media = new TestPublishMedia({
      engineConfig: {
        groupDurationSec: 0.5,
        connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
        dataTracks: [{ name: 'overlay', role: 'data' }],
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
    // The peer solicits announces (empty prefix covers every namespace)
    // the way the real relay does right after SETUP. Opened after
    // publish(): the in-memory pair only completes a write once the far
    // side reads, and the publish session (the reader) exists only once
    // publishing starts.
    const solicitation = await solicitNamespace(pair.server, []);

    // The session accepts the solicitation and announces the namespace on
    // it — the whole ingest offer; no per-track PUBLISH exists anymore.
    await vi.waitFor(
      () => {
        expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
      },
      { timeout: 15_000 }
    );
    // Empty solicited prefix → the suffix is the full namespace.
    expect(solicitation.received[1]).toMatchObject({ kind: 'namespace', trackNamespaceSuffix: ['live', 'abc123'] });

    // publish() resolves once the session is live — "announced", under
    // announce-and-serve, not "PUBLISH accepted".
    await expect(published).resolves.toBeUndefined();
    expect(media.publishState).toBe('live');
    expect(media.publishStartedAt).not.toBeNaN();
    expect(statuses).toEqual(['idle', 'connecting', 'ready', 'live']);

    // Pull the published tracks with the existing driver: the publisher
    // serves each SUBSCRIBE with SUBSCRIBE_OK, and a track publisher
    // writes nothing until its subscription binds — the catalog replays
    // its latest frame on bind, so subscribing after `live` still yields
    // the current catalog.
    const namespace = ['live', 'abc123'];
    const collect = (trackName: string) => {
      const objects: MoqtObject[] = [];
      subscriber.subscribe({ trackNamespace: namespace, trackName }, { onObject: (object) => objects.push(object) });
      return { objects };
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
    expect(names).toContain('overlay');
    expect(parsed.tracks.every((track) => track.packaging === 'loc' && track.isLive)).toBe(true);
    expect(parsed.tracks.find((track) => track.name === 'audio')?.codec).toBe('opus');
    expect(parsed.tracks.find((track) => track.name === 'overlay')?.role).toBe('data');

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

    // The application data track rides the same broadcast: a page-published
    // payload reaches the subscriber LOC-extractable once its subscription
    // binds (pull-through — nothing flows before the SUBSCRIBE above).
    const overlay = collect('overlay');
    const producer = media.engine.context.dataTrackProducers.get()!.overlay!;
    await vi.waitFor(() => {
      const bindings = media.engine.context.publishSessionActor.get()!.snapshot.get().context.trackBindings;
      expect(bindings.overlay).toBeDefined();
    });
    producer.publish(new TextEncoder().encode('LIVE: hello overlay'), { timestampUs: 123_000_000 });
    await vi.waitFor(
      () => {
        expect(overlay.objects.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 }
    );
    const overlayFrame = toLocFrame(overlay.objects[0]!)!;
    expect(utf8Decode(overlayFrame.payload)).toBe('LIVE: hello overlay');
    expect(overlayFrame.timestampUs).toBe(123_000_000);
    expect(overlay.objects[0]!.objectId).toBe(0);

    // Unpublish: the announce is retracted with NAMESPACE_DONE on the
    // solicitation stream (each subscribe stream ends with a bare FIN —
    // PUBLISH_DONE never appears) and the session returns to idle.
    media.unpublish();
    await vi.waitFor(
      () => {
        expect(solicitation.received.map((m) => m.kind)).toContain('namespace-done');
      },
      { timeout: 10_000 }
    );
    await vi.waitFor(() => {
      expect(media.publishState).toBe('idle');
    });
    // The publisher never fell back to proactive PUBLISH ingest.
    expect(proactivePublishes).toEqual([]);
  }, 60_000);
});
