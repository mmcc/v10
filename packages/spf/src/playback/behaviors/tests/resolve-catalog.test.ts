import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { signal } from '../../../core/signals/primitives';
import { isResolvedPresentation, type MaybeResolvedPresentation } from '../../../media/types';
import { getTracksByType } from '../../../media/utils/tracks';
import { utf8Encode } from '../../../network/moqt/bytes';
import {
  type MessageParameters,
  PUBLISH_DONE_STATUS,
  REQUEST_ERROR_CODE,
} from '../../../network/moqt/control-messages';
import type { MoqtSession, SubscriptionHandlers } from '../../../network/moqt/session';
import type { MoqSessionActor, MoqSessionActorContext } from '../../actors/moq-session';
import { resolveCatalog } from '../resolve-catalog';

const MOQ_URL = 'moqt://relay.example.com/live#msf:live--catalog';

const CATALOG = JSON.stringify({
  version: '1',
  tracks: [{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 1_000_000 }],
});

const DELTA = JSON.stringify({
  version: '1',
  deltaUpdate: [
    { op: 'add', tracks: [{ name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus' }] },
  ],
});

const CATALOG_WITH_AUDIO = JSON.stringify({
  version: '1',
  tracks: [
    { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 1_000_000 },
    { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus' },
  ],
});

/** The join every catalog attempt asks for: the current group from its independent object (§5.1.2). */
const CURRENT_GROUP = { type: 'relative-group', groupsBeforeNext: 1 };

// ============================================================================
// Fakes
// ============================================================================

interface SubscribeOptions {
  trackNamespace: string[];
  trackName: string;
  parameters?: MessageParameters;
}

function createFakeSessionActor() {
  const subscriptions: { options: SubscribeOptions; handlers: SubscriptionHandlers; cancelled: boolean }[] = [];
  const fetches: unknown[] = [];
  const session = {
    ready: Promise.resolve(),
    subscribe(options: SubscribeOptions, handlers: SubscriptionHandlers = {}) {
      const record = { options, handlers, cancelled: false };

      subscriptions.push(record);
      return {
        requestId: (subscriptions.length - 1) * 2,
        update: () => {},
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
    fetch(options: unknown) {
      fetches.push(options);
      return { requestId: 100, cancel: () => {} };
    },
    trackStatus: () => {},
    close: () => {},
    destroy: () => {},
  } as unknown as MoqtSession;

  const snapshot = signal({
    value: 'active' as const,
    context: { status: 'ready', session } as MoqSessionActorContext,
  });
  // The real actor's refreshAuthToken always rejects — the connect-time-only
  // ?jwt= carriage means a refreshed token has no connection left to attach
  // to (see moq-session.ts). This fake matches that contract rather than
  // resolving with a shape the actor can no longer produce.
  const refreshAuthToken = vi.fn(async (): Promise<never> => {
    throw new Error('cannot refresh the MoQ auth token: the actor does not reconnect');
  });
  const actor: MoqSessionActor = {
    snapshot: snapshot as MoqSessionActor['snapshot'],
    getAuthParameters: () => ({}),
    refreshAuthToken,
    destroy: () => {},
  };

  return { actor, subscriptions, fetches, refreshAuthToken };
}

function catalogObject(groupId: number, objectId: number, text: string) {
  return {
    groupId,
    objectId,
    subgroupId: 0,
    status: 'normal' as const,
    properties: [],
    payload: utf8Encode(text),
  };
}

function makeDeps(actor: MoqSessionActor | undefined, presentation: MaybeResolvedPresentation | undefined) {
  return {
    state: { presentation: signal<MaybeResolvedPresentation | undefined>(presentation) },
    context: { moqSessionActor: signal<MoqSessionActor | undefined>(actor) },
  };
}

const publishDone = { statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 0, reason: 'broadcast ended' };

/** Signal effects re-run on the microtask queue; two turns settle a cascade. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

/**
 * Comfortably past the first restart backoff: attempt 0 is 500ms jittered ±25%, so any wait above 625ms is
 * deterministic.
 */
const PAST_FIRST_BACKOFF_MS = 1000;

// ============================================================================
// Tests
// ============================================================================

describe('resolveCatalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to the catalog track from the start of the current group once the session is ready', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    expect(subscriptions[0]!.options).toMatchObject({
      trackNamespace: ['live'],
      trackName: 'catalog',
      parameters: { locationFilter: CURRENT_GROUP },
    });
    // No FETCH: the relay replays the group on the subscription itself.
    expect(fetches).toHaveLength(0);

    reactor.destroy();
    expect(subscriptions[0]!.cancelled).toBe(true);
  });

  it('resolves the presentation from the replayed independent catalog object', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));

    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);
    expect(subscriptions[0]!.cancelled).toBe(false); // live updates keep flowing

    reactor.destroy();
  });

  it('applies deltas against the independent object of their own group', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));

    await vi.waitFor(() => {
      const presentation = deps.state.presentation.get();

      expect(isResolvedPresentation(presentation)).toBe(true);
      expect(getTracksByType(presentation!, 'audio')).toHaveLength(1);
    });

    reactor.destroy();
  });

  // A publisher that does not replay the current group delivers from the
  // next object: a delta with no base.
  it('drops a delta with no base and recovers on the next independent object', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));

    // A dangling delta with no prior catalog is dropped...
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    // ...and the next group's independent catalog resolves.
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, CATALOG));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));

    reactor.destroy();
  });

  // Groups travel on separate streams, so an older group's tail can land
  // after a newer group's independent object. Applying it would land the
  // old delta on the new base.
  it('drops a straggling delta from a superseded group', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, CATALOG));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));

    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);

    reactor.destroy();
  });

  it('drops a straggling independent object from a superseded group', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, CATALOG));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);

    // The older group's catalog arrives late: it must not roll the
    // presentation back, and its deltas must stay dropped too.
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG_WITH_AUDIO));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);

    // The base group's own deltas still apply.
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 1, DELTA));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);

    reactor.destroy();
  });

  // A malformed independent object must not move the base: otherwise the
  // new group's deltas would apply to the previous group's catalog.
  it('keeps the previous base when an independent object fails to parse', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));

    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, '{"version":"1","tracks":'));
    expect(consoleError).toHaveBeenCalledWith('[resolveCatalog] catalog parse failed:', expect.anything());

    // Group 6's delta has no valid base of its own; it must not land on
    // group 5's catalog.
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 1, DELTA));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);

    // The next well-formed independent object recovers.
    subscriptions[0]!.handlers.onObject?.(catalogObject(7, 0, CATALOG_WITH_AUDIO));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // refreshAuthToken always rejects (see moq-session.ts) — a refreshed
  // token has no connection left to attach to. The one-shot retry must
  // give up as a terminal state like any other permanent rejection:
  // freeze it, so nothing of the dead attempt keeps writing the
  // presentation and no queued restart reopens the subscription.
  it('gives up cleanly on EXPIRED_AUTH_TOKEN since refreshAuthToken cannot supply a usable token', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions, refreshAuthToken } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    await vi.waitFor(() => expect(refreshAuthToken).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[resolveCatalog] auth refresh failed:', expect.any(Error))
    );

    // Terminal freezes the state: no retry, handle cancelled, and a late
    // object from the dead attempt must not reach the presentation.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.cancelled).toBe(true);
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // A second expiry from the stopped attempt is stale — no second
    // refresh, no new subscription.
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired again',
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(subscriptions).toHaveLength(1);
    expect(refreshAuthToken).toHaveBeenCalledOnce();
    consoleError.mockRestore();

    reactor.destroy();
  });

  // The `attempt`/`isCurrent` guard: `start()` runs again for every non-auth
  // retry and PUBLISH_DONE resubscribe, and cancelling a subscription does
  // not stop callbacks already in flight, so a cancelled first attempt's
  // late object must not write the retry attempt's presentation.
  it('ignores objects from a superseded attempt', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 0,
      reason: 'no such track',
    });
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);

    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG_WITH_AUDIO));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    subscriptions[1]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    await flush();
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true);
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);

    reactor.destroy();
  });

  // The common failure is DOES_NOT_EXIST: play was pressed before the
  // broadcast started, so the retry cadence is also the join latency.
  it('re-subscribes with backoff after a non-auth subscribe error', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 0,
      reason: 'no such track',
    });
    expect(subscriptions).toHaveLength(1); // the restart waits out the backoff

    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]!.cancelled).toBe(true);
    // Every attempt joins the same way: the current group from its start.
    expect(subscriptions[1]!.options.parameters).toMatchObject({ locationFilter: CURRENT_GROUP });

    // The broadcast appeared: the fresh attempt resolves from its own objects.
    subscriptions[1]!.handlers.onObject?.(catalogObject(1, 0, CATALOG));
    await flush();
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true);
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);

    reactor.destroy();
  });

  // An outage can outlive the auth token: EXPIRED → refresh → the track is
  // gone (non-auth retries) → the token expires again once the broadcaster
  // returns. Each non-auth failure re-arms the one-shot refresh, so the
  // second expiry refreshes again instead of reading as a rejected refresh.
  //
  // Exercised through a *resolving* refresh seam: today's fleet rejects
  // every refresh (the give-up path is pinned above), but the behavior is
  // seam-generic and the session actor keeps `refreshAuthToken` on its
  // interface for a relay generation that accepts request-parameter tokens.
  it('re-arms the auth refresh across a non-auth retry cycle', async () => {
    vi.useFakeTimers();
    const base = createFakeSessionActor();
    const { subscriptions } = base;
    const refreshAuthToken = vi.fn(async () => ({}));
    const actor: MoqSessionActor = { ...base.actor, refreshAuthToken };
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    await flush();
    expect(subscriptions).toHaveLength(2);
    expect(refreshAuthToken).toHaveBeenCalledOnce();

    // The broadcaster is gone: the refreshed attempt fails non-auth and
    // enters the generic backoff cycle.
    subscriptions[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 0,
      reason: 'no such track',
    });
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(3);

    // The broadcaster returned after the token expired again: refresh a
    // second time rather than stopping as a rejected refresh.
    subscriptions[2]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired again',
    });
    await flush();
    expect(refreshAuthToken).toHaveBeenCalledTimes(2);
    expect(subscriptions).toHaveLength(4);

    reactor.destroy();
  });

  // A permanent rejection — wrong credentials, malformed request — answers
  // an identical retry identically: looping on it forever just loads the
  // relay for nothing.
  it('does not retry a permanent catalog rejection', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.UNAUTHORIZED,
      retryInterval: 0,
      reason: 'wrong claims',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[resolveCatalog] catalog subscribe failed (non-retryable):',
      expect.anything()
    );
    consoleError.mockRestore();

    reactor.destroy();
  });

  it('does not re-subscribe after an auth-shaped PUBLISH_DONE', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    // The re-subscribe would carry the same credentials the relay just
    // rejected — unlike TRACK_ENDED (covered below), this must not poll.
    subscriptions[0]!.handlers.onDone?.({
      statusCode: PUBLISH_DONE_STATUS.UNAUTHORIZED,
      streamCount: 0,
      reason: 'unauthorized',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    // Terminal freezes the state: handle cancelled, and a late object from
    // the dead attempt must not reach the presentation.
    expect(subscriptions[0]!.cancelled).toBe(true);
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // One death can reach the behavior as two reports (see scheduleRestart):
  // a retryable PUBLISH_DONE books the restart, then a permanent error for
  // the same subscription declares the state terminal. The already-armed
  // restart timer must not fire afterwards and reopen the subscription
  // right over the terminal state.
  it('cancels a booked restart when a terminal report follows a retryable one', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onDone?.(publishDone);
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.UNAUTHORIZED,
      retryInterval: 0,
      reason: 'wrong claims',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // The refreshed token being rejected too is a terminal state like any
  // other permanent rejection: freeze it.
  it('freezes the state when the refreshed token is rejected too', async () => {
    vi.useFakeTimers();
    const base = createFakeSessionActor();
    const { subscriptions } = base;
    const refreshAuthToken = vi.fn(async () => ({}));
    const actor: MoqSessionActor = { ...base.actor, refreshAuthToken };
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    await flush();
    expect(subscriptions).toHaveLength(2);

    subscriptions[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired again',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshAuthToken).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.cancelled).toBe(true);
    subscriptions[1]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // A refresh that resolves only after the attempt went terminal must not
  // restart the catalog on its own — the queued start() would undo the
  // terminal freeze exactly like an armed retry timer would.
  it('does not let a late auth refresh undo a terminal stop', async () => {
    vi.useFakeTimers();
    const base = createFakeSessionActor();
    const { subscriptions } = base;
    let resolveRefresh: () => void = () => {};
    const refreshAuthToken = vi.fn(
      () =>
        new Promise<MessageParameters>((resolve) => {
          resolveRefresh = () => resolve({});
        })
    );
    const actor: MoqSessionActor = { ...base.actor, refreshAuthToken };
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    expect(refreshAuthToken).toHaveBeenCalledOnce();

    // The track goes terminal while the refresh is still in flight.
    subscriptions[0]!.handlers.onDone?.({
      statusCode: PUBLISH_DONE_STATUS.UNAUTHORIZED,
      streamCount: 0,
      reason: 'unauthorized',
    });

    resolveRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // PUBLISH_DONE means the broadcaster ended or dropped the catalog track,
  // not that the session is unhealthy — poll the track back into existence.
  it('re-subscribes when the publisher ends the catalog track', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onDone?.(publishDone);
    expect(subscriptions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]!.cancelled).toBe(true);

    reactor.destroy();
  });

  // Across a publisher restart the track's (group, object) numbering starts
  // over, so a delta applied against the pre-outage catalog would silently
  // produce a wrong track list.
  it('resets the catalog base across a restart so a delta cannot apply to the pre-outage catalog', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();

    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    await flush();
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true);

    subscriptions[0]!.handlers.onDone?.(publishDone);
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);

    // A delta from the restarted publisher has no base to apply to, so it is
    // dropped; the last resolved presentation stands.
    subscriptions[1]!.handlers.onObject?.(catalogObject(1, 1, DELTA));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(0);
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);

    // The next independent object rebuilds the base and updates the projection.
    subscriptions[1]!.handlers.onObject?.(catalogObject(2, 0, CATALOG_WITH_AUDIO));
    await flush();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);

    reactor.destroy();
  });

  it('honors a server-stated retry interval above the local backoff', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXCESSIVE_LOAD,
      retryInterval: 5000,
      reason: 'come back later',
    });

    // The attempt-0 backoff is at most 625ms, so the effective delay is the
    // server's 5000ms exactly.
    await vi.advanceTimersByTimeAsync(4000);
    expect(subscriptions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1100);
    expect(subscriptions).toHaveLength(2);

    reactor.destroy();
  });

  it('does not re-subscribe when the retry budget is zero', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup({ ...deps, config: { subscribeRetry: { maxAttempts: 0 } } });

    await flush();

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 0,
      reason: 'no such track',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    reactor.destroy();
  });

  it('cancels a pending retry when the behavior tears down', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await flush();

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 0,
      reason: 'no such track',
    });

    // Leaving 'catalog-active' (here: the source went away) drops the timer.
    deps.state.presentation.set(undefined);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);

    reactor.destroy();
  });

  it('stays idle for non-moqt sources and before the session is ready', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const httpDeps = makeDeps(actor, { url: 'https://example.com/live.m3u8' });
    const httpReactor = resolveCatalog.setup(httpDeps);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscriptions).toHaveLength(0);
    httpReactor.destroy();

    const noSessionDeps = makeDeps(undefined, { url: MOQ_URL });
    const noSessionReactor = resolveCatalog.setup(noSessionDeps);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscriptions).toHaveLength(0);
    noSessionReactor.destroy();
  });
});
