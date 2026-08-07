import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComposition } from '../../../core/composition/create-composition';
import { signal } from '../../../core/signals/primitives';
import { createMoqtSession } from '../../../network/moqt/session';
import { type RawRequest, rawSubscribe, solicitNamespace } from '../../../network/moqt/tests/helpers/raw-peer';
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

function makePeer(pair: TransportPair) {
  const closes: unknown[] = [];
  const peer = createMoqtSession(pair.server, {
    callbacks: {
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
    cameraState: signal<OpenPublishSessionState['cameraState']>('idle'),
    screenShareState: signal<OpenPublishSessionState['screenShareState']>('idle'),
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
  state.cameraState.set('active');
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
    makePeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    openGate(state);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });

    // A track registers (setupTrackPublishers' job in the composed
    // engine) and the peer solicits the namespace; the announce lands
    // and the session is live.
    const actor = context.publishSessionActor.get()!;
    actor.snapshot.get().context.session!.registerTrack({ trackNamespace: ENDPOINT.namespace, trackName: 'catalog' });
    void solicitNamespace(pair.server, []);
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('live');
    });
    expect(state.publishError.get()).toBeUndefined();
  });

  it('tears the session down on unpublish and settles on closed', async () => {
    const pair = createTransportPair();
    const { closes } = makePeer(pair);
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
  // publishers quiesce and FIN their tracks' subscription streams while
  // the transport lives).
  // ---------------------------------------------------------------------------

  function makeTransportStage(pair: TransportPair) {
    const composition = createComposition([setupTrackPublishers, openPublishSession], {
      config: { connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }) },
      initialState: { publishActivated: false, cameraState: 'idle', screenShareState: 'idle', sessionStatus: 'idle' },
    });
    disposals.push(() => void composition.destroy());
    makePeer(pair);

    const subscriptions = {} as { catalog: RawRequest; video: RawRequest };

    const goLive = async () => {
      composition.state.endpoint.set(ENDPOINT);
      composition.state.activeEncodings.set({ camera: { codec: 'vp8', width: 640, height: 480 } });
      composition.state.publishActivated.set(true);
      composition.state.cameraState.set('active');
      void solicitNamespace(pair.server, []);
      await vi.waitFor(() => {
        expect(composition.state.sessionStatus.get()).toBe('live');
      });

      // Hold live subscriptions on both tracks so the teardown's clean
      // end (a bare stream FIN) is observable, and open one video group
      // so an in-flight data stream rides through the teardown too.
      subscriptions.catalog = await rawSubscribe(pair.server, ENDPOINT.namespace, 'catalog', 11);
      subscriptions.video = await rawSubscribe(pair.server, ENDPOINT.namespace, 'video', 13);
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

    return { composition, subscriptions, goLive };
  }

  it('FINs every track subscription cleanly when the composition is destroyed', async () => {
    const pair = createTransportPair();
    const { composition, subscriptions, goLive } = makeTransportStage(pair);
    await goLive();

    // The production teardown path — no manual draining beforehand.
    await composition.destroy();

    await vi.waitFor(() => {
      expect(subscriptions.catalog.ended()).toBe(true);
      expect(subscriptions.video.ended()).toBe(true);
    });
    // A bare FIN is the clean draft-19 track end — any trailing message
    // (the old PUBLISH_DONE) makes moq-lite-rs abort the track instead.
    expect(subscriptions.catalog.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    expect(subscriptions.video.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
  });

  it('FINs every track subscription when unpublish collapses the gate', async () => {
    const pair = createTransportPair();
    const { composition, subscriptions, goLive } = makeTransportStage(pair);
    await goLive();

    composition.state.publishActivated.set(false);

    await vi.waitFor(() => {
      expect(subscriptions.catalog.ended()).toBe(true);
      expect(subscriptions.video.ended()).toBe(true);
    });
    expect(subscriptions.catalog.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    expect(subscriptions.video.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    // An orderly stop, not a failure.
    await vi.waitFor(() => {
      expect(composition.state.sessionStatus.get()).toBe('closed');
    });
    expect(composition.state.publishError.get()).toBeUndefined();
  });

  it('clears a prior session error on the next attempt', async () => {
    let attempts = 0;
    const pair = createTransportPair();
    makePeer(pair);
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
