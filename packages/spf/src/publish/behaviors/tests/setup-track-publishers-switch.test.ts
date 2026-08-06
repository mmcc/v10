import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { createMoqtSession, type PublishDone } from '../../../network/moqt/session';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import { createPublishSessionActor, type PublishSessionActor } from '../../session/publish-session';
import {
  type SetupTrackPublishersContext,
  type SetupTrackPublishersState,
  setupTrackPublishers,
} from '../setup-track-publishers';

/**
 * Source-switch regression coverage: the track publishers are keyed on
 * the session + track names, so encoder churn — `activeEncodings`
 * clearing transiently and returning with a fresh identity, as a camera
 * device change (or a screen share starting/stopping mid-session)
 * produces — must not destroy them, re-PUBLISH the tracks, or emit
 * PUBLISH_DONE. A relay treats PUBLISH_DONE as the end of the track;
 * every subscriber would freeze.
 */

const ENDPOINT = { url: 'https://relay.example.com/moq', namespace: ['live', 'abc123'] };

const VIDEO_CONFIG = { codec: 'avc1.42E01F', width: 640, height: 480 } as VideoEncoderConfig;
const SCREEN_VIDEO_CONFIG = { codec: 'avc1.42E01F', width: 1280, height: 720 } as VideoEncoderConfig;
const AUDIO_CONFIG = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 } as AudioEncoderConfig;

const disposals: (() => void)[] = [];

function makeSessionActor() {
  const pair = createTransportPair();
  const publishes: string[] = [];
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
  return { actor, peer, publishes };
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

  it('keeps the publishers alive across an activeEncodings identity change (no destroy, no PUBLISH_DONE)', async () => {
    const { actor, peer, publishes } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'video', 'audio']);
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    const catalogPublisher = context.catalogTrackPublisher.get()!;
    const videoPublisher = context.videoTrackPublisher.get()!;
    const audioPublisher = context.audioTrackPublisher.get()!;

    // A downstream subscriber would see any PUBLISH_DONE — record them.
    const dones: PublishDone[] = [];
    for (const trackName of ['video', 'audio'] as const) {
      peer.subscribe(
        { trackNamespace: ENDPOINT.namespace, trackName },
        { onObject: () => undefined, onDone: (done) => dones.push(done) }
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The switch: encodings clear while the new source is probed…
    state.activeEncodings.set(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // …and return with a fresh identity (new resolution, same kinds).
    state.activeEncodings.set({ camera: SCREEN_VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Same actors, same tracks, no churn on the wire.
    expect(context.catalogTrackPublisher.get()).toBe(catalogPublisher);
    expect(context.videoTrackPublisher.get()).toBe(videoPublisher);
    expect(context.audioTrackPublisher.get()).toBe(audioPublisher);
    expect(videoPublisher.snapshot.get().value).toBe('publishing');
    expect(audioPublisher.snapshot.get().value).toBe('publishing');
    expect(publishes).toEqual(['catalog', 'video', 'audio']);
    expect(dones).toEqual([]);
    expect(actor.snapshot.get().context.status).toBe('live');
    expect(state.publishError.get()).toBeUndefined();
  });

  it('adds a kind that appears mid-session without touching the existing publishers', async () => {
    const { actor, publishes } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    context.publishSessionActor.set(actor);

    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'video']);
    });
    const videoPublisher = context.videoTrackPublisher.get()!;
    expect(context.audioTrackPublisher.get()).toBeUndefined();

    // The mic's independent pipeline finishes acquiring after the camera's:
    // the audio track is offered additively once it does.
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await vi.waitFor(() => {
      expect(context.audioTrackPublisher.get()).toBeDefined();
      expect(publishes).toEqual(['catalog', 'video', 'audio']);
    });
    expect(context.videoTrackPublisher.get()).toBe(videoPublisher);
    expect(videoPublisher.snapshot.get().value).toBe('publishing');
  });

  it('keeps a publisher whose kind disappears rather than ending its track mid-session', async () => {
    const { actor, publishes } = makeSessionActor();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.publishSessionActor.set(actor);
    await vi.waitFor(() => {
      expect(publishes).toEqual(['catalog', 'video', 'audio']);
    });
    const audioPublisher = context.audioTrackPublisher.get()!;

    // A mic device error drops the audio encoding: the track goes quiet, not away.
    state.activeEncodings.set({ camera: SCREEN_VIDEO_CONFIG });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.audioTrackPublisher.get()).toBe(audioPublisher);
    expect(audioPublisher.snapshot.get().value).toBe('publishing');
    expect(publishes).toEqual(['catalog', 'video', 'audio']);
  });
});
