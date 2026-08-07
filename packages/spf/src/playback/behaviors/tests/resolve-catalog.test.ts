import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { isResolvedPresentation, type MaybeResolvedPresentation } from '../../../media/types';
import { getTracksByType } from '../../../media/utils/tracks';
import { utf8Encode } from '../../../network/moqt/bytes';
import { PUBLISH_DONE_STATUS, REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
import type { FetchHandlers, MoqtSession, SubscriptionHandlers } from '../../../network/moqt/session';
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

// ============================================================================
// Fakes
// ============================================================================

function createFakeSessionActor() {
  const subscriptions: {
    options: { trackNamespace: string[]; trackName: string };
    handlers: SubscriptionHandlers;
    cancelled: boolean;
  }[] = [];
  const fetches: { options: unknown; handlers: FetchHandlers; cancelled: boolean }[] = [];
  const session = {
    ready: Promise.resolve(),
    subscribe(options: { trackNamespace: string[]; trackName: string }, handlers: SubscriptionHandlers = {}) {
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
    fetch(options: unknown, handlers: FetchHandlers = {}) {
      const record = { options, handlers, cancelled: false };
      fetches.push(record);
      return {
        requestId: 100,
        cancel: () => {
          record.cancelled = true;
        },
      };
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

function fetchEntry(groupId: number, objectId: number, text: string) {
  return {
    kind: 'object' as const,
    groupId,
    objectId,
    priority: 128,
    properties: [],
    payload: utf8Encode(text),
  };
}

const publishDone = { statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 0, reason: 'broadcast ended' };

/** Signal effects re-run on the microtask queue; two turns settle a cascade. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

/**
 * Comfortably past the first restart backoff: attempt 0 is 500ms jittered
 * ±25%, so any wait above 625ms is deterministic.
 */
const PAST_FIRST_BACKOFF_MS = 1000;

// ============================================================================
// Tests
// ============================================================================

describe('resolveCatalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes to the catalog track with a joining fetch once the session is ready', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    expect(subscriptions[0]!.options).toMatchObject({ trackNamespace: ['live'], trackName: 'catalog' });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.options).toMatchObject({ type: 'relative-joining', joiningRequestId: 0, joiningStart: 0 });

    reactor.destroy();
    expect(subscriptions[0]!.cancelled).toBe(true);
    expect(fetches[0]!.cancelled).toBe(true);
  });

  it('resolves the presentation from fetched catalog objects', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]!.handlers.onEntry?.(fetchEntry(5, 0, CATALOG));
    fetches[0]!.handlers.onEnd?.();

    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);
    expect(subscriptions[0]!.cancelled).toBe(false); // live updates keep flowing

    reactor.destroy();
  });

  it('applies live delta updates after the fetch settles', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(fetches).toHaveLength(1));

    // Live delta lands before the fetch replay finishes — it must buffer.
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    fetches[0]!.handlers.onEntry?.(fetchEntry(5, 0, CATALOG));
    fetches[0]!.handlers.onEnd?.();

    await vi.waitFor(() => {
      const presentation = deps.state.presentation.get();
      expect(isResolvedPresentation(presentation)).toBe(true);
      expect(getTracksByType(presentation!, 'audio')).toHaveLength(1);
    });

    reactor.destroy();
  });

  it('recovers via the next independent object when the fetch fails', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]!.handlers.onError?.({ errorCode: 0x11, retryInterval: 0, reason: 'invalid range' });

    // A dangling delta with no prior catalog is dropped...
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    // ...and the next group's independent catalog resolves.
    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, CATALOG));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));

    reactor.destroy();
  });

  // refreshAuthToken always rejects (see moq-session.ts) — a refreshed
  // token has no connection left to attach to. The one-shot retry must
  // still give up cleanly: log the failure, leave the original
  // subscription/fetch in place, and never retry again.
  it('gives up cleanly on EXPIRED_AUTH_TOKEN since refreshAuthToken cannot supply a usable token', async () => {
    const { actor, subscriptions, fetches, refreshAuthToken } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });

    await vi.waitFor(() => expect(refreshAuthToken).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[resolveCatalog] auth refresh failed:', expect.any(Error))
    );
    // No retry: the original subscription/fetch are untouched, and the
    // catalog stays unresolved rather than a pointless second request.
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.cancelled).toBe(false);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.cancelled).toBe(false);
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    // A second expiry is log-only too — the retry is one-shot regardless
    // of whether the first refresh attempt succeeded or failed.
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired again',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscriptions).toHaveLength(1);
    expect(refreshAuthToken).toHaveBeenCalledOnce();
    consoleError.mockRestore();

    reactor.destroy();
  });

  // A relay can answer FETCH_OK and then never open its data stream, so
  // onEnd/onError/onReset never fire and the session's request timeout has
  // nothing to catch. Without a settle deadline the catalog buffers live
  // deltas forever and never resolves.
  it('falls back to live-only when the joining fetch never settles', async () => {
    const { actor, subscriptions } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup({ ...deps, config: { catalogFetchTimeoutMs: 10 } });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);

    reactor.destroy();
  });

  // The deadline switches to live-only, but the relay may still deliver
  // the joining fetch's replay afterwards. Those entries are older than
  // the live catalog by construction — applying one would roll the
  // presentation back (or land the next delta on the wrong base).
  it('ignores fetch entries that arrive after the settle deadline', async () => {
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup({ ...deps, config: { catalogFetchTimeoutMs: 10 } });

    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    // The deadline also cancels the replay stream outright.
    await vi.waitFor(() => expect(fetches[0]!.cancelled).toBe(true));

    subscriptions[0]!.handlers.onObject?.(catalogObject(6, 0, CATALOG_WITH_AUDIO));
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);

    // A straggling replay entry (an older group) must not overwrite it.
    fetches[0]!.handlers.onEntry?.(fetchEntry(5, 0, CATALOG));
    fetches[0]!.handlers.onEnd?.();
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);
    expect(getTracksByType(deps.state.presentation.get()!, 'video')).toHaveLength(1);

    reactor.destroy();
  });

  // The `attempt`/`isCurrent` guard got its live path back: `start()` runs
  // again for every non-auth retry and PUBLISH_DONE resubscribe, so a
  // cancelled first fetch's late callback must not disturb the retry
  // attempt. (An earlier revision drove this through a successful auth
  // refresh, which the current relay fleet's connect-URL-only jwt carriage
  // made unreachable — the recovery restart is the reachable path now.)
  it('keeps a cancelled first fetch from settling the retry attempt early', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions, fetches } = createFakeSessionActor();
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
    expect(fetches).toHaveLength(2);

    // Cancelling a fetch does not stop callbacks already in flight — the
    // first fetch's late settle must not flush the retry's buffer early.
    fetches[0]!.handlers.onEnd?.();

    // Still buffering: the retry's live delta waits for its own fetch...
    subscriptions[1]!.handlers.onObject?.(catalogObject(5, 1, DELTA));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    // ...and applies in order once that fetch replays the base catalog.
    fetches[1]!.handlers.onEntry?.(fetchEntry(5, 0, CATALOG));
    fetches[1]!.handlers.onEnd?.();
    await flush();
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true);
    expect(getTracksByType(deps.state.presentation.get()!, 'audio')).toHaveLength(1);

    reactor.destroy();
  });

  // The common failure is DOES_NOT_EXIST: play was pressed before the
  // broadcast started, so the retry cadence is also the join latency.
  it('re-subscribes with backoff after a non-auth subscribe error', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions, fetches } = createFakeSessionActor();
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
    expect(fetches).toHaveLength(2);
    expect(subscriptions[0]!.cancelled).toBe(true);
    expect(fetches[0]!.cancelled).toBe(true);
    expect(fetches[1]!.options).toMatchObject({ type: 'relative-joining', joiningRequestId: 2, joiningStart: 0 });

    // The broadcast appeared: the fresh attempt resolves from its own objects.
    fetches[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.INVALID_RANGE,
      retryInterval: 0,
      reason: 'no history',
    });
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
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await flush();
    expect(subscriptions).toHaveLength(1);

    // A live catalog object buffered behind the unsettled joining fetch —
    // the settle timer's drain path, which never checks the attempt token.
    subscriptions[0]!.handlers.onObject?.(catalogObject(5, 0, CATALOG));
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);

    // The re-subscribe would carry the same credentials the relay just
    // rejected — unlike TRACK_ENDED (covered below), this must not poll.
    subscriptions[0]!.handlers.onDone?.({
      statusCode: PUBLISH_DONE_STATUS.UNAUTHORIZED,
      streamCount: 0,
      reason: 'unauthorized',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(subscriptions).toHaveLength(1);
    // Terminal freezes the state: handles cancelled, and the settle timer
    // disarmed with the buffer discarded — past the fetch deadline, the
    // buffered object must NOT have drained into the presentation.
    expect(subscriptions[0]!.cancelled).toBe(true);
    expect(fetches[0]!.cancelled).toBe(true);
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    consoleError.mockRestore();

    reactor.destroy();
  });

  // PUBLISH_DONE means the broadcaster ended or dropped the catalog track,
  // not that the session is unhealthy — poll the track back into existence.
  it('re-subscribes when the publisher ends the catalog track', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    await flush();
    expect(subscriptions).toHaveLength(1);

    subscriptions[0]!.handlers.onDone?.(publishDone);
    expect(subscriptions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);
    expect(fetches).toHaveLength(2);
    expect(subscriptions[0]!.cancelled).toBe(true);
    expect(fetches[0]!.cancelled).toBe(true);

    reactor.destroy();
  });

  // Across a publisher restart the track's (group, object) numbering starts
  // over, so a delta applied against the pre-outage catalog would silently
  // produce a wrong track list.
  it('resets the catalog base across a restart so a delta cannot apply to the pre-outage catalog', async () => {
    vi.useFakeTimers();
    const { actor, subscriptions, fetches } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);
    await flush();

    fetches[0]!.handlers.onEntry?.(fetchEntry(5, 0, CATALOG));
    fetches[0]!.handlers.onEnd?.();
    await flush();
    expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true);

    subscriptions[0]!.handlers.onDone?.(publishDone);
    await vi.advanceTimersByTimeAsync(PAST_FIRST_BACKOFF_MS);
    expect(subscriptions).toHaveLength(2);

    // Nothing published yet on the restarted track — live-only from here.
    fetches[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.INVALID_RANGE,
      retryInterval: 0,
      reason: 'no history',
    });

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
    expect(vi.getTimerCount()).toBe(0); // retry and settle timers both cleared
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
