import { afterEach, describe, expect, it, vi } from 'vitest';
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
 * Source-switch regression coverage: re-acquiring capture drives
 * `captureStatus` through `active → acquiring → active`, and an open
 * session must ride that out — closing it sends PUBLISH_DONE for every
 * track and drops the transport, which a relay treats as the end of the
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

describe('openPublishSession', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('keeps the session open while a capture-source switch re-acquires', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.captureStatus.set('active');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });
    const actor = context.publishSessionActor.get()!;

    // Camera → screen: the acquire behavior re-enters through 'acquiring'.
    state.captureStatus.set('acquiring');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.publishSessionActor.get()).toBe(actor);
    expect(state.sessionStatus.get()).toBe('ready');
    expect(closes).toEqual([]);

    state.captureStatus.set('active');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.publishSessionActor.get()).toBe(actor);
    expect(closes).toEqual([]);
    expect(state.publishError.get()).toBeUndefined();
  });

  it('does not open a session for a first acquire still in flight', async () => {
    const connect = vi.fn();
    const { state, context } = setupBehavior(connect as unknown as ConnectPublishTransport);

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.captureStatus.set('acquiring');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connect).not.toHaveBeenCalled();
    expect(context.publishSessionActor.get()).toBeUndefined();
    expect(state.sessionStatus.get()).toBe('idle');
  });

  it('still closes the session when capture releases or ends', async () => {
    const pair = createTransportPair();
    const { closes } = makeAcceptingPeer(pair);
    const { state, context } = setupBehavior(() => ({ transport: pair.client, ready: Promise.resolve() }));

    state.endpoint.set(ENDPOINT);
    state.publishActivated.set(true);
    state.captureStatus.set('active');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('ready');
    });

    // The platform ended the tracks (device unplugged, "Stop sharing").
    state.captureStatus.set('ended');
    await vi.waitFor(() => {
      expect(state.sessionStatus.get()).toBe('closed');
      expect(context.publishSessionActor.get()).toBeUndefined();
    });
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
  });
});
