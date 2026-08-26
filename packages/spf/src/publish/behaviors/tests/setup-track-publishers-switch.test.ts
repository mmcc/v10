import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { signal } from '../../../core/signals/primitives';
import { createMoqtSession } from '../../../network/moqt/session';
import { rawSubscribe, solicitNamespace } from '../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import { createPublishSessionActor, type PublishSessionActor } from '../../session/publish-session';
import {
  type SetupTrackPublishersContext,
  type SetupTrackPublishersState,
  setupTrackPublishers,
} from '../setup-track-publishers';

/**
 * Source-switch regression coverage: the track publishers are keyed on the session + track names, so encoder churn —
 * `activeEncodings` clearing transiently and returning with a fresh identity, as a camera device change (or a screen
 * share starting/stopping mid-session) produces — must not destroy them or end the served tracks. A relay treats a
 * subscription-stream FIN as the end of the track; every subscriber would freeze.
 */

const ENDPOINT = { url: 'https://relay.example.com/moq', namespace: ['live', 'abc123'] };

const VIDEO_CONFIG = { codec: 'avc1.42E01F', width: 640, height: 480 } as VideoEncoderConfig;
const SCREEN_VIDEO_CONFIG = { codec: 'avc1.42E01F', width: 1280, height: 720 } as VideoEncoderConfig;
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
    dataTrackProducers: signal<SetupTrackPublishersContext['dataTrackProducers']>(undefined),
  };
  const reactor = setupTrackPublishers.setup({ state, context, config: {} });

  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

describe('setupTrackPublishers', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('keeps the publishers alive across an activeEncodings identity change (no destroy, no track end)', async () => {
    const { actor, server } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);
    void solicitNamespace(server, []);

    await vi.waitFor(() => {
      expect(context.audioTrackPublisher.get()).toBeDefined();
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    const catalogPublisher = context.catalogTrackPublisher.get()!;
    const videoPublisher = context.videoTrackPublisher.get()!;
    const audioPublisher = context.audioTrackPublisher.get()!;

    // A downstream subscriber's stream ending IS the track ending — hold
    // live subscriptions and watch for any churn on them.
    const video = await rawSubscribe(server, ENDPOINT.namespace, 'video', 11);
    const audio = await rawSubscribe(server, ENDPOINT.namespace, 'audio', 13);

    await vi.waitFor(() => {
      expect(video.received).toHaveLength(1);
      expect(audio.received).toHaveLength(1);
    });

    // The switch: encodings clear while the new source is probed…
    state.activeEncodings.set(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // …and return with a fresh identity (new resolution, same kinds).
    state.activeEncodings.set({ camera: SCREEN_VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Same actors, same tracks, no churn on the wire: the subscription
    // streams carry exactly their SUBSCRIBE_OK and stay open.
    expect(context.catalogTrackPublisher.get()).toBe(catalogPublisher);
    expect(context.videoTrackPublisher.get()).toBe(videoPublisher);
    expect(context.audioTrackPublisher.get()).toBe(audioPublisher);
    expect(videoPublisher.snapshot.get().value).toBe('publishing');
    expect(audioPublisher.snapshot.get().value).toBe('publishing');
    expect(video.ended()).toBe(false);
    expect(audio.ended()).toBe(false);
    expect(video.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    expect(audio.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    expect(actor.snapshot.get().context.status).toBe('live');
  });

  it('adds a kind that appears mid-session without touching the existing publishers', async () => {
    const { actor, peer } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(context.videoTrackPublisher.get()).toBeDefined();
    });
    const videoPublisher = context.videoTrackPublisher.get()!;

    expect(context.audioTrackPublisher.get()).toBeUndefined();

    // The mic's independent pipeline finishes acquiring after the camera's:
    // the audio track is registered additively once it does.
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await vi.waitFor(() => {
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });
    expect(context.videoTrackPublisher.get()).toBe(videoPublisher);
    expect(videoPublisher.snapshot.get().value).toBe('publishing');

    const audioAliases: number[] = [];

    peer.subscribe(
      { trackNamespace: ENDPOINT.namespace, trackName: 'audio' },
      { onOk: (ok) => audioAliases.push(ok.trackAlias) }
    );
    await vi.waitFor(() => {
      expect(audioAliases).toHaveLength(1);
    });
  });

  it('keeps a publisher whose kind disappears rather than ending its track mid-session', async () => {
    const { actor, server } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);
    await vi.waitFor(() => {
      expect(context.audioTrackPublisher.get()).toBeDefined();
    });
    const audioPublisher = context.audioTrackPublisher.get()!;
    const audio = await rawSubscribe(server, ENDPOINT.namespace, 'audio', 21);

    await vi.waitFor(() => {
      expect(audio.received).toHaveLength(1);
    });

    // A mic device error drops the audio encoding: the track goes quiet, not away.
    state.activeEncodings.set({ camera: SCREEN_VIDEO_CONFIG });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.audioTrackPublisher.get()).toBe(audioPublisher);
    expect(audioPublisher.snapshot.get().value).toBe('publishing');
    expect(audio.ended()).toBe(false);
    expect(audio.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
  });
});
