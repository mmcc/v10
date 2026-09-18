import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { signal } from '../../../core/signals/primitives';
import { createMoqtSession } from '../../../network/moqt/session';
import { createTransportPair, type TransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import type { ConnectPublishTransport } from '../../session/publish-session';
import {
  type OpenPublishSessionContext,
  type OpenPublishSessionState,
  openPublishSession,
} from '../open-publish-session';

/**
 * Source-switch regression coverage: a camera device change drives `cameraState` through `active → acquiring → active`
 * independently of `screenShareState`, and an open session must ride either pipeline's transient reacquire out —
 * closing it sends PUBLISH_DONE for every track and drops the transport, which a relay treats as the end of the
 * broadcast.
 */

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
    micActive: signal<OpenPublishSessionState['micActive']>(false),
    cameraState: signal<OpenPublishSessionState['cameraState']>('idle'),
    screenShareState: signal<OpenPublishSessionState['screenShareState']>('idle'),
    micState: signal<OpenPublishSessionState['micState']>('idle'),
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

describe('openPublishSession', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('keeps the session open while a camera device change re-acquires', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.cameraState.set('active');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });
    const actor = context.publishSessionActor.get()!;

    // A device-id change re-enters through 'acquiring'.
    state.cameraState.set('acquiring');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.publishSessionActor.get()).toBe(actor);
    expect(state.sessionStatus.get()).toBe('ready');
    expect(closes).toEqual([]);

    state.cameraState.set('active');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.publishSessionActor.get()).toBe(actor);
    expect(closes).toEqual([]);
    expect(state.publishError.get()).toBeUndefined();
  });

  it('stays open on screenShareState alone while the camera reacquires', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.screenShareState.set('active');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });
    const actor = context.publishSessionActor.get()!;

    // Camera starts acquiring while screen stays active throughout.
    state.cameraState.set('acquiring');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.publishSessionActor.get()).toBe(actor);
    expect(closes).toEqual([]);
  });

  it('does not open a session for a first acquire still in flight', async () => {
    const connect = vi.fn();
    const { state, context } = setupBehavior(connect as unknown as ConnectPublishTransport);

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.cameraState.set('acquiring');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect).not.toHaveBeenCalled();
    expect(context.publishSessionActor.get()).toBeUndefined();
    expect(state.sessionStatus.get()).toBe('idle');
  });

  it('still closes the session when both capture pipelines release or end', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.cameraState.set('active');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });

    // The platform ended the track (device unplugged, "Stop sharing").
    state.cameraState.set('ended');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('closed');
      expect(context.publishSessionActor.get()).toBeUndefined();
    });
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
  });
});
