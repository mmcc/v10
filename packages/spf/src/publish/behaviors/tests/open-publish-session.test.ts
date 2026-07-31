import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposition } from '../../../core/composition/create-composition';
import { signal } from '../../../core/signals/primitives';
import { PUBLISH_DONE_STATUS } from '../../../network/moqt/control-messages';
import { createMoqtSession, type PublishDone } from '../../../network/moqt/session';
import { createTransportPair, type TransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import type { ConnectPublishTransport } from '../../session/publish-session';
import {
  type OpenPublishSessionContext,
  type OpenPublishSessionState,
  openPublishSession,
} from '../open-publish-session';
import { setupTrackPublishers } from '../setup-track-publishers';

const ENDPOINT = { url: 'https://relay.example.com/moq', namespace: ['live', 'abc123'] };

const disposals: (() => void)[] = [];

function makeAcceptingPeer(pair: TransportPair) {
  const closes: unknown[] = [];
  const peer = createMoqtSession(pair.server, {
    callbacks: {
      onIncomingPublish: (_publish, respond) => respond.accept(),
      onClosed: (info) => closes.push(info),
    },
  });
  disposals.push(() => peer.destroy());
  return { peer, closes };
}

function setupBehavior(connectTransport: ConnectPublishTransport) {
  const state = {
    endpoint: signal<OpenPublishSessionState['endpoint']>(undefined),
    publishActivated: signal<OpenPublishSessionState['publishActivated']>(false),
    captureStatus: signal<OpenPublishSessionState['captureStatus']>('idle'),
    sessionStatus: signal<OpenPublishSessionState['sessionStatus']>('idle'),
    publishError: signal<OpenPublishSessionState['publishError']>(undefined),
  };
  const context = {
    publishSessionActor: signal<OpenPublishSessionContext['publishSessionActor']>(undefined),
  };
  const reactor = openPublishSession.setup({ state, context, config: { connectTransport } });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

function openGate(state: ReturnType<typeof setupBehavior>['state']): void {
  state.endpoint.set(ENDPOINT);
  state.publishActivated.set(true);
  state.captureStatus.set('active');
}

describe('openPublishSession', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('stays idle until endpoint, activation, and active capture align', async () => {
    const connect = vi.fn();
    const { state, context } = setupBehavior(connect as unknown as ConnectPublishTransport);

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connect).not.toHaveBeenCalled();
    expect(state.sessionStatus.get()).toBe('idle');
    expect(context.publishSessionActor.get()).toBeUndefined();
  });

  it('opens the session and mirrors the actor lifecycle into sessionStatus', async () => {
    const pair = createTransportPair();
    makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    openGate(state);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });
    const actor = context.publishSessionActor.get()!;
    const session = actor.snapshot.get().context.session!;

    session.publishTrack({ trackNamespace: ENDPOINT.namespace, trackName: 'video' });
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('live');
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('tears the session down on unpublish and settles on closed', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    openGate(state);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });

    state.publishActivated.set(false);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('closed');
      expect(context.publishSessionActor.get()).toBeUndefined();
    });
    // The peer observed the transport close.
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('surfaces a connect failure as sessionStatus error with a transport publishError', async () => {
    const { state } = setupBehavior(() => {
      throw new Error('connect refused');
    });

    openGate(state);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('error');
    });
    expect(state.publishError.get()).toMatchObject({ code: 'transport', message: 'connect refused' });
  });

  // ---------------------------------------------------------------------------
  // Production-path teardown: the transport stage composed the way the moq
  // publish engine composes it (setupTrackPublishers before
  // openPublishSession — cleanups run in composition order, so the
  // publishers quiesce and queue PUBLISH_DONE while the transport lives).
  // ---------------------------------------------------------------------------

  function makeTransportStage(pair: TransportPair) {
    const composition = createComposition([setupTrackPublishers, openPublishSession], {
      config: { connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }) },
      initialState: { publishActivated: false, captureStatus: 'idle', sessionStatus: 'idle' },
    });
    disposals.push(() => void composition.destroy());

    const dones = { catalog: [] as PublishDone[], video: [] as PublishDone[] };
    const { peer } = makeAcceptingPeer(pair);

    const goLive = async () => {
      composition.state.endpoint.set(ENDPOINT);
      composition.state.activeEncodings.set({ video: { codec: 'vp8', width: 640, height: 480 } });
      composition.state.publishActivated.set(true);
      composition.state.captureStatus.set('active');
      await vi.waitFor(() => {
        expect(composition.state.sessionStatus.get()).toBe('live');
      });

      // Subscribe to both offered tracks so PUBLISH_DONE has subscriber
      // streams to land on, and open one video group so the video track
      // has an opened data stream to report.
      peer.subscribe(
        { trackNamespace: ENDPOINT.namespace, trackName: 'catalog' },
        { onDone: (done) => dones.catalog.push(done) }
      );
      peer.subscribe(
        { trackNamespace: ENDPOINT.namespace, trackName: 'video' },
        { onDone: (done) => dones.video.push(done) }
      );
      await vi.waitFor(() => {
        const actor = composition.context.publishSessionActor.get()!;
        expect(actor.snapshot.get().context.subscriberCount).toBe(2);
      });
      const video = composition.context.videoTrackPublisher.get()!;
      video.send({ type: 'frame', payload: new Uint8Array([1, 2, 3]), properties: [], keyframe: true, timestampUs: 0 });
      await vi.waitFor(() => {
        expect(video.snapshot.get().context.openedGroups).toBe(1);
      });
    };

    return { composition, dones, goLive };
  }

  it('delivers PUBLISH_DONE for every track when the composition is destroyed', async () => {
    const pair = createTransportPair();
    const { composition, dones, goLive } = makeTransportStage(pair);
    await goLive();

    // The production teardown path — no manual draining beforehand.
    await composition.destroy();

    await vi.waitFor(() => {
      expect(dones.catalog).toHaveLength(1);
      // Stream Count reports data streams OPENED (draft-19 §10.11), so the
      // still-open video group counts.
      expect(dones.video).toMatchObject([{ statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 1 }]);
    });
  });

  it('delivers PUBLISH_DONE for every track when unpublish collapses the gate', async () => {
    const pair = createTransportPair();
    const { composition, dones, goLive } = makeTransportStage(pair);
    await goLive();

    composition.state.publishActivated.set(false);

    await vi.waitFor(() => {
      expect(dones.catalog).toHaveLength(1);
      expect(dones.video).toMatchObject([{ statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 1 }]);
    });
    // An orderly stop, not a failure.
    await vi.waitFor(() => {
      expect(composition.state.sessionStatus.get()).toBe('closed');
    });
    expect(composition.state.publishError.get()).toBeUndefined();
  });

  it('clears a prior session error on the next attempt', async () => {
    let attempts = 0;
    const pair = createTransportPair();
    makeAcceptingPeer(pair);
    const { state } = setupBehavior(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect refused');
      return { transport: pair.client, ready: Promise.resolve() };
    });

    openGate(state);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('error');
    });

    // Re-arm the gate with a fresh endpoint identity.
    state.publishActivated.set(false);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('error');
    });
    state.endpoint.set({ ...ENDPOINT });
    state.publishActivated.set(true);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });
    expect(state.publishError.get()).toBeUndefined();
  });
});
