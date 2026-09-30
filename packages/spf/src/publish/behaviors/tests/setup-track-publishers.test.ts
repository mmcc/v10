import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { signal } from '../../../core/signals/primitives';
import { parseLocProperties } from '../../../media/moq/loc';
import { REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
import type { MoqtObject } from '../../../network/moqt/object-stream';
import { createMoqtSession } from '../../../network/moqt/session';
import { solicitNamespace } from '../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import { createPublishSessionActor, type PublishSessionActor } from '../../session/publish-session';
import {
  type SetupTrackPublishersConfig,
  type SetupTrackPublishersContext,
  type SetupTrackPublishersState,
  setupTrackPublishers,
} from '../setup-track-publishers';

const ENDPOINT = { url: 'https://relay.example.com/moq', namespace: ['live', 'abc123'] };

const VIDEO_CONFIG = { codec: 'vp8', width: 640, height: 480 } as VideoEncoderConfig;
const AUDIO_CONFIG = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } as AudioEncoderConfig;

const disposals: (() => void)[] = [];

function makeSessionActor() {
  const pair = createTransportPair();
  const peer = createMoqtSession(pair.server, {});

  disposals.push(() => peer.destroy());
  const actor: PublishSessionActor = createPublishSessionActor({
    endpoint: ENDPOINT,
    connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
  });

  disposals.push(() => actor.destroy());
  return { actor, peer, server: pair.server, client: pair.client };
}

function setupBehavior(config: SetupTrackPublishersConfig = {}) {
  const state = {
    activeEncodings: signal<SetupTrackPublishersState['activeEncodings']>(undefined),
    endpoint: signal<SetupTrackPublishersState['endpoint']>(undefined),
  };
  const context = {
    publishSessionActor: signal<SetupTrackPublishersContext['publishSessionActor']>(undefined),
    catalogTrackPublisher: signal<SetupTrackPublishersContext['catalogTrackPublisher']>(undefined),
    videoTrackPublisher: signal<SetupTrackPublishersContext['videoTrackPublisher']>(undefined),
    screenTrackPublisher: signal<SetupTrackPublishersContext['screenTrackPublisher']>(undefined),
    audioTrackPublisher: signal<SetupTrackPublishersContext['audioTrackPublisher']>(undefined),
    dataTrackProducers: signal<SetupTrackPublishersContext['dataTrackProducers']>(undefined),
  };
  const reactor = setupTrackPublishers.setup({ state, context, config });

  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

describe('setupTrackPublishers', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it.each([
    { name: 'default', priorities: undefined, expected: [0, 128, 192, 64] },
    { name: 'custom', priorities: { audio: 0, camera: 255, screen: 32 }, expected: [0, 255, 32, 0] },
    { name: 'invalid', priorities: { audio: NaN, camera: -1, screen: 256, catalog: 0.5 }, expected: [0, 128, 192, 64] },
  ])('carries $name track priorities on the wire and into upload scheduling', async ({ priorities, expected }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { actor, peer, server, client } = makeSessionActor();
    const open = vi.spyOn(client, 'createUnidirectionalStream');
    const { state, context } = setupBehavior({
      trackPriorities: priorities,
      dataTracks: [{ name: 'overlay', priority: 17 }],
    });

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, screen: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);
    void solicitNamespace(server, []);
    await vi.waitFor(() => expect(context.audioTrackPublisher.get()).toBeDefined());

    const received: Record<string, number | undefined> = {};
    const names = ['catalog', 'video', 'screen', 'audio', 'overlay'];

    for (const trackName of names) {
      peer.subscribe(
        { trackNamespace: ENDPOINT.namespace, trackName },
        {
          onObject: (object) => {
            received[trackName] = object.priority;
          },
        }
      );
    }

    await vi.waitFor(() => expect(Object.keys(actor.snapshot.get().context.trackBindings)).toHaveLength(names.length));

    for (const slot of [
      'catalogTrackPublisher',
      'videoTrackPublisher',
      'screenTrackPublisher',
      'audioTrackPublisher',
    ] as const) {
      context[slot]
        .get()!
        .send({ type: 'frame', payload: new Uint8Array([1]), properties: [], keyframe: true, timestampUs: 0 });
    }

    context.dataTrackProducers.get()!.overlay!.publish(new Uint8Array([1]));
    await vi.waitFor(() => expect(Object.keys(received)).toHaveLength(names.length));
    expect(names.map((name) => received[name])).toEqual([...expected, 17]);

    for (const priority of [...expected, 17]) {
      expect(open).toHaveBeenCalledWith({ sendOrder: -1 - priority });
    }
  });

  it('registers catalog + active tracks and publishes the actor slots once the session is ready', async () => {
    const { actor, peer } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.catalogTrackPublisher.get()).toBeDefined();
      expect(context.videoTrackPublisher.get()).toBeDefined();
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });

    // Registration is local under announce-and-serve — the observable
    // proof is that the peer's SUBSCRIBEs are answered.
    const aliases: number[] = [];

    for (const trackName of ['catalog', 'video', 'audio'] as const) {
      peer.subscribe({ trackNamespace: ENDPOINT.namespace, trackName }, { onOk: (ok) => aliases.push(ok.trackAlias) });
    }

    await vi.waitFor(() => {
      expect(aliases).toHaveLength(3);
      expect(actor.snapshot.get().context.subscriberCount).toBe(3);
    });
  });

  it('skips the video publisher for an audio-only encoding', async () => {
    const { actor, peer } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.catalogTrackPublisher.get()).toBeDefined();
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });
    expect(context.videoTrackPublisher.get()).toBeUndefined();

    // The unregistered track is refused, the registered one served.
    const errors: number[] = [];
    const audioAliases: number[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'video' },
      { onError: (error) => errors.push(error.errorCode) }
    );
    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'audio' },
      { onOk: (ok) => audioAliases.push(ok.trackAlias) }
    );
    await vi.waitFor(() => {
      expect(errors).toEqual([REQUEST_ERROR_CODE.DOES_NOT_EXIST]);
      expect(audioAliases).toHaveLength(1);
    });
  });

  it('adds the screen publisher additively alongside camera', async () => {
    const { actor, peer } = makeSessionActor();
    const { state, context } = setupBehavior();
    const SCREEN_CONFIG = { codec: 'vp8', width: 1920, height: 1080 } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    await vi.waitFor(() => {
      expect(context.videoTrackPublisher.get()).toBeDefined();
    });
    expect(context.screenTrackPublisher.get()).toBeUndefined();

    // Screen share starts mid-session — additive, camera's publisher untouched.
    const cameraPublisher = context.videoTrackPublisher.get()!;

    state.activeEncodings.set({ camera: VIDEO_CONFIG, screen: SCREEN_CONFIG });

    await vi.waitFor(() => {
      expect(context.screenTrackPublisher.get()).toBeDefined();
    });
    expect(context.videoTrackPublisher.get()).toBe(cameraPublisher);

    const screenAliases: number[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'screen' },
      { onOk: (ok) => screenAliases.push(ok.trackAlias) }
    );
    await vi.waitFor(() => {
      expect(screenAliases).toHaveLength(1);
    });
  });

  it('binds a publisher to the subscription and data flows only from the bind on', async () => {
    const { actor, peer, server } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    void solicitNamespace(server, []);
    await vi.waitFor(() => {
      expect(context.videoTrackPublisher.get()).toBeDefined();
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    const publisher = context.videoTrackPublisher.get()!;

    // Unsubscribed: a keyframe opens no stream (pull-through ingest) but
    // is retained as the in-progress group.
    publisher.send({ type: 'frame', payload: new Uint8Array([1]), properties: [], keyframe: true, timestampUs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(publisher.snapshot.get().context.openedGroups).toBe(0);

    const payloads: Uint8Array[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'video' },
      { onObject: (object) => payloads.push(object.payload) }
    );
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.trackBindings.video).toBeDefined();
    });

    // The binding-sync effect bound the publisher, which replays the
    // retained in-progress group from object 0 — the instant join.
    await vi.waitFor(() => {
      expect(payloads).toHaveLength(1);
    });
    expect(payloads[0]).toEqual(new Uint8Array([1]));

    // A live keyframe follows on the same subscription.
    publisher.send({
      type: 'frame',
      payload: new Uint8Array([2, 2]),
      properties: [],
      keyframe: true,
      timestampUs: 1_000,
    });
    await vi.waitFor(() => {
      expect(payloads).toHaveLength(2);
    });
    expect(payloads[1]).toEqual(new Uint8Array([2, 2]));
  });

  it('keeps the publishers through an encodings gap and destroys them when the session goes away', async () => {
    const { actor } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    await vi.waitFor(() => {
      expect(context.videoTrackPublisher.get()).toBeDefined();
    });
    const publisher = context.videoTrackPublisher.get()!;

    // A source switch clears the encodings while it re-probes — the
    // registered tracks must ride that out (ending one FINs its
    // subscriptions, ending the track for every subscriber).
    state.activeEncodings.set(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.videoTrackPublisher.get()).toBe(publisher);
    expect(context.catalogTrackPublisher.get()).toBeDefined();
    expect(publisher.snapshot.get().value).toBe('publishing');

    // The cluster is keyed on the session: losing it tears everything down.
    context.publishSessionActor.set(undefined);
    await vi.waitFor(() => {
      expect(context.videoTrackPublisher.get()).toBeUndefined();
      expect(context.catalogTrackPublisher.get()).toBeUndefined();
    });
    expect(publisher.snapshot.get().value).toBe('destroyed');
  });

  it('registers configured data tracks with the cluster and serves a producer-published payload', async () => {
    const { actor, peer, server } = makeSessionActor();
    const { state, context } = setupBehavior({ dataTracks: [{ name: 'overlay', role: 'data' }] });

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    void solicitNamespace(server, []);

    await vi.waitFor(() => {
      expect(context.dataTrackProducers.get()?.overlay).toBeDefined();
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    const producer = context.dataTrackProducers.get()!.overlay!;

    expect(producer.trackName).toBe('overlay');

    // Unbound (pull-through): a publish before any subscription is dropped.
    producer.publish(new TextEncoder().encode('early'), { timestampUs: 1 });

    const objects: MoqtObject[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'overlay' },
      { onObject: (object) => objects.push(object) }
    );
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.trackBindings.overlay).toBeDefined();
    });

    producer.publish(new TextEncoder().encode('hello overlay'), { timestampUs: 42_000_000 });
    await vi.waitFor(() => {
      expect(objects).toHaveLength(1);
    });
    expect(new TextDecoder().decode(objects[0]!.payload)).toBe('hello overlay');
    // LOC-packaged: the payload carries a microsecond timestamp property.
    expect(parseLocProperties(objects[0]!.properties)).toMatchObject({
      timestamp: 42_000_000,
      timescale: 1_000_000,
    });
    // Every payload is its own single-object group (a random-access point).
    expect(objects[0]!.objectId).toBe(0);
  });

  it('drops data tracks whose name collides with a reserved or earlier track, or cannot key a record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    disposals.push(() => warn.mockRestore());
    const { actor, peer } = makeSessionActor();
    const { state, context } = setupBehavior({
      // `__proto__` and `constructor` would corrupt or misread the
      // name-keyed records (producers, trackBindings) — refused up front.
      dataTracks: [
        { name: 'video' },
        { name: 'overlay' },
        { name: 'overlay' },
        { name: '__proto__' },
        { name: 'constructor' },
      ],
    });

    // One warning per dropped config: reserved `video`, duplicate
    // `overlay`, and the two prototype-member names.
    expect(warn).toHaveBeenCalledTimes(4);

    state.endpoint.set(ENDPOINT);
    // Audio-only encodings: the engine itself never registers `video`, so
    // a served `video` track could only have come from the colliding
    // data-track config.
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.dataTrackProducers.get()).toBeDefined();
    });
    expect(Object.keys(context.dataTrackProducers.get()!)).toEqual(['overlay']);

    const errors: number[] = [];
    const overlayAliases: number[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'video' },
      { onError: (error) => errors.push(error.errorCode) }
    );
    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'overlay' },
      { onOk: (ok) => overlayAliases.push(ok.trackAlias) }
    );
    await vi.waitFor(() => {
      expect(errors).toEqual([REQUEST_ERROR_CODE.DOES_NOT_EXIST]);
      expect(overlayAliases).toHaveLength(1);
    });
  });

  it('replays the latest payload to a new subscription when the track opts into replay', async () => {
    const { actor, peer, server } = makeSessionActor();
    const { state, context } = setupBehavior({
      dataTracks: [{ name: 'overlay', replayLastOnSubscribe: true }],
    });

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    void solicitNamespace(server, []);
    await vi.waitFor(() => {
      expect(context.dataTrackProducers.get()?.overlay).toBeDefined();
      expect(actor.snapshot.get().context.status).toBe('live');
    });

    // Published while nothing subscribes — retained for replay.
    context.dataTrackProducers.get()!.overlay!.publish(new TextEncoder().encode('current state'), {
      timestampUs: 7,
    });

    const payloads: Uint8Array[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'overlay' },
      { onObject: (object) => payloads.push(object.payload) }
    );
    await vi.waitFor(() => {
      expect(payloads).toHaveLength(1);
    });
    expect(new TextDecoder().decode(payloads[0]!)).toBe('current state');
  });

  it('clears the producer slot when the session goes away', async () => {
    const { actor } = makeSessionActor();
    const { state, context } = setupBehavior({ dataTracks: [{ name: 'overlay' }] });

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);
    await vi.waitFor(() => {
      expect(context.dataTrackProducers.get()?.overlay).toBeDefined();
    });

    context.publishSessionActor.set(undefined);
    await vi.waitFor(() => {
      expect(context.dataTrackProducers.get()).toBeUndefined();
    });
  });
});
