import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
import { createMoqtSession } from '../../../network/moqt/session';
import { solicitNamespace } from '../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import { createPublishSessionActor, type PublishSessionActor } from '../../session/publish-session';
import {
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
  return { actor, peer, server: pair.server };
}

function setupBehavior() {
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
  };
  const reactor = setupTrackPublishers.setup({ state, context, config: {} });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

describe('setupTrackPublishers', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
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

    // Unsubscribed: a keyframe goes nowhere (pull-through ingest).
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

    // The binding-sync effect has bound the publisher — the next keyframe
    // reaches the subscriber.
    publisher.send({
      type: 'frame',
      payload: new Uint8Array([2, 2]),
      properties: [],
      keyframe: true,
      timestampUs: 1_000,
    });
    await vi.waitFor(() => {
      expect(payloads).toHaveLength(1);
    });
    expect(payloads[0]).toEqual(new Uint8Array([2, 2]));
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
});
