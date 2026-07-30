import { describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { isResolvedPresentation, type MaybeResolvedPresentation } from '../../../media/types';
import { getTracksByType } from '../../../media/utils/tracks';
import { utf8Encode } from '../../../network/moqt/bytes';
import { REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
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
  const refreshAuthToken = vi.fn(async () => ({ authorizationTokens: [new Uint8Array([1])] }));
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

// ============================================================================
// Tests
// ============================================================================

describe('resolveCatalog', () => {
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
    fetches[0]!.handlers.onEntry?.({
      kind: 'object',
      groupId: 5,
      objectId: 0,
      priority: 128,
      properties: [],
      payload: utf8Encode(CATALOG),
    });
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
    fetches[0]!.handlers.onEntry?.({
      kind: 'object',
      groupId: 5,
      objectId: 0,
      priority: 128,
      properties: [],
      payload: utf8Encode(CATALOG),
    });
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

  it('refreshes the token and recreates the catalog subscription on EXPIRED_AUTH_TOKEN', async () => {
    const { actor, subscriptions, fetches, refreshAuthToken } = createFakeSessionActor();
    const deps = makeDeps(actor, { url: MOQ_URL });
    const reactor = resolveCatalog.setup(deps);

    await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(refreshAuthToken).toHaveBeenCalledOnce();
    expect(subscriptions[0]!.cancelled).toBe(true);
    expect(fetches[0]!.cancelled).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(subscriptions[1]!.options).toMatchObject({
      trackNamespace: ['live'],
      trackName: 'catalog',
      parameters: { authorizationTokens: [new Uint8Array([1])] },
    });

    // The fresh attempt resolves the catalog through its own joining fetch.
    fetches[1]!.handlers.onEntry?.({
      kind: 'object',
      groupId: 5,
      objectId: 0,
      priority: 128,
      properties: [],
      payload: utf8Encode(CATALOG),
    });
    fetches[1]!.handlers.onEnd?.();
    await vi.waitFor(() => expect(isResolvedPresentation(deps.state.presentation.get())).toBe(true));

    // A second expiry is log-only — the retry is one-shot.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscriptions[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired again',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(subscriptions).toHaveLength(2);
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
