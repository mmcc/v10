import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { createMoqtSession } from '../../../network/moqt/session';
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
  const publishes: string[] = [];
  const dones: { statusCode: number }[] = [];
  const peer = createMoqtSession(pair.server, {
    callbacks: {
      onIncomingPublish: (publish, respond) => {
        publishes.push(publish.trackName);
        respond.accept();
      },
    },
  });
  disposals.push(() => peer.destroy());
  const actor: PublishSessionActor = createPublishSessionActor({
    endpoint: ENDPOINT,
    connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
  });
  disposals.push(() => actor.destroy());
  return { actor, peer, publishes, dones };
}

function setupBehavior() {
  const state = {
    activeEncodings: signal<SetupTrackPublishersState['activeEncodings']>(undefined),
    endpoint: signal<SetupTrackPublishersState['endpoint']>(undefined),
    publishError: signal<SetupTrackPublishersState['publishError']>(undefined),
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

  it('offers catalog + active tracks and publishes the actor slots once the session is ready', async () => {
    const { actor, publishes } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.catalogTrackPublisher.get()).toBeDefined();
      expect(context.videoTrackPublisher.get()).toBeDefined();
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'video', 'audio']);
    });
    // Accepted offers move the session actor to live.
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('live');
      expect(actor.snapshot.get().context.publishedTracks).toBe(3);
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('skips the video publisher for an audio-only encoding', async () => {
    const { actor, publishes } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.catalogTrackPublisher.get()).toBeDefined();
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });
    expect(context.videoTrackPublisher.get()).toBeUndefined();
    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'audio']);
    });
  });

  it('adds the screen publisher additively alongside camera', async () => {
    const { actor, publishes } = makeSessionActor();
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
    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'video', 'screen']);
    });
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
    // PUBLISHed tracks must ride that out (destroying one sends
    // PUBLISH_DONE, ending the track for every subscriber).
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
