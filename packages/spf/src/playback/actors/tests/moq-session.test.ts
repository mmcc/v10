import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoqSource } from '../../../media/moq/parse-source';
import { encodeSetup } from '../../../network/moqt/control-messages';
import type { MoqtTransport } from '../../../network/moqt/session';
import { type CreateMoqTransport, createMoqSessionActor } from '../moq-session';

// ============================================================================
// Minimal in-memory transport: enough for the session driver to reach
// 'ready' (client SETUP write + server SETUP arrival).
// ============================================================================

function createFakeTransport() {
  let uniController!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  let closeInfo: { closeCode?: number; reason?: string } | undefined;
  let resolveClosed!: (value: unknown) => void;

  const transport: MoqtTransport = {
    incomingUnidirectionalStreams: new ReadableStream({
      start(controller) {
        uniController = controller;
      },
    }),
    incomingBidirectionalStreams: new ReadableStream({ start() {} }),
    async createUnidirectionalStream() {
      return new WritableStream<Uint8Array>();
    },
    async createBidirectionalStream() {
      return { readable: new ReadableStream<Uint8Array>({ start() {} }), writable: new WritableStream<Uint8Array>() };
    },
    close(info) {
      // Record argument-less closes too, so tests can assert close happened.
      closeInfo = info ?? {};
      resolveClosed(info);
    },
    closed: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
  };

  return {
    transport,
    sendServerSetup() {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      void pipe.writable.getWriter().write(encodeSetup([]));
      uniController.enqueue(pipe.readable);
    },
    /**
     * The peer or the network dropped the connection: `closed` settles
     * without anyone calling `close()` locally, which is how the session
     * driver learns about an outage.
     */
    drop() {
      resolveClosed(undefined);
    },
    getCloseInfo: () => closeInfo,
  };
}

function makeSource(overrides: Partial<MoqSource> = {}): MoqSource {
  return {
    connectUrl: 'https://relay.example.com/live',
    sessionUri: 'moqt://relay.example.com/live',
    namespace: ['live'],
    trackName: 'catalog',
    fragmentParams: {},
    ...overrides,
  };
}

function makeCreateTransport(fake: ReturnType<typeof createFakeTransport>): CreateMoqTransport {
  return (connectUrl, protocols) => {
    makeCreateTransport.lastConnect = { connectUrl, protocols };
    return { transport: fake.transport, ready: Promise.resolve() };
  };
}
makeCreateTransport.lastConnect = undefined as { connectUrl: string; protocols: string[] } | undefined;

// ============================================================================
// Tests
// ============================================================================

describe('createMoqSessionActor', () => {
  it('connects with the draft protocol id and reaches ready on the server SETUP', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({ source: makeSource(), createTransport: makeCreateTransport(fake) });

    expect(actor.snapshot.get().context.status).toBe('connecting');
    expect(makeCreateTransport.lastConnect).toMatchObject({
      connectUrl: 'https://relay.example.com/live',
      protocols: ['moqt-19'],
    });

    fake.sendServerSetup();
    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('ready'));
    expect(actor.snapshot.get().context.session).toBeDefined();

    actor.destroy();
  });

  it('fails when the transport cannot connect and reconnect is disabled, closing the half-open transport', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport: () => ({
        transport: fake.transport,
        ready: Promise.reject(new Error('handshake failed')),
      }),
      // Pin the terminal path; the default retries (covered below).
      reconnect: { maxAttempts: 0 },
    });

    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('failed'));
    expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);
    // The rejected `ready` does not close the transport on its own — the
    // failure path must, or the relay connection leaks.
    expect(fake.getCloseInfo()).toBeDefined();

    actor.destroy();
  });

  it('does not connect when destroyed while the auth token is pending', async () => {
    let resolveToken!: (value: string) => void;
    const createTransport = vi.fn(makeCreateTransport(createFakeTransport()));
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport,
      authProvider: {
        getToken: () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
      },
    });

    actor.destroy();
    resolveToken('token');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createTransport).not.toHaveBeenCalled();
  });

  it('fails without connecting when the source mandates native QUIC', async () => {
    // MSF §11.1.1: connection=q means native QUIC MUST be used, which the
    // WebTransport default cannot provide.
    const webTransportSpy = vi.fn();
    vi.stubGlobal('WebTransport', webTransportSpy);
    try {
      const actor = createMoqSessionActor({ source: makeSource({ connection: 'quic' }) });

      await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('failed'));
      expect(String(actor.snapshot.get().context.error)).toMatch(/QUIC/);
      expect(webTransportSpy).not.toHaveBeenCalled();

      actor.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honors a QUIC mandate when a custom transport factory is supplied', async () => {
    // A non-browser host may legitimately provide native QUIC through the
    // factory seam — the mandate check must not block it.
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ connection: 'quic' }),
      createTransport: makeCreateTransport(fake),
    });

    fake.sendServerSetup();
    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('ready'));

    actor.destroy();
  });

  it('serializes the c4m fragment token into auth parameters', () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'abc' }),
      createTransport: makeCreateTransport(fake),
    });

    const parameters = actor.getAuthParameters();
    expect(parameters.authorizationTokens).toHaveLength(1);
    // Token structure: Alias Type USE_VALUE (0x3), token type 0, value 'abc'.
    expect(parameters.authorizationTokens![0]).toEqual(new Uint8Array([0x3, 0x0, 0x61, 0x62, 0x63]));

    actor.destroy();
  });

  it('prefers the auth provider token and refreshes through it', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'stale' }),
      createTransport: makeCreateTransport(fake),
      authProvider: {
        getToken: () => 'fresh',
        refreshToken: () => 'refreshed',
        tokenType: 2,
      },
    });

    await vi.waitFor(() => {
      const tokens = actor.getAuthParameters().authorizationTokens;
      expect(tokens?.[0]).toEqual(new Uint8Array([0x3, 0x2, ...new TextEncoder().encode('fresh')]));
    });

    const refreshed = await actor.refreshAuthToken();
    expect(refreshed.authorizationTokens?.[0]).toEqual(
      new Uint8Array([0x3, 0x2, ...new TextEncoder().encode('refreshed')])
    );

    actor.destroy();
  });

  it('rejects refreshAuthToken when the provider cannot supply a fresh token', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'stale' }),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken: () => 'stale', refreshToken: () => undefined },
    });

    // Resolving with the same stale parameters would trigger a pointless
    // second unauthorized request — give-up must surface as rejection.
    await expect(actor.refreshAuthToken()).rejects.toThrow(/fresh token/);

    actor.destroy();
  });

  it('rejects refreshAuthToken without an auth provider', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'abc' }),
      createTransport: makeCreateTransport(fake),
    });

    await expect(actor.refreshAuthToken()).rejects.toThrow(/fresh token/);

    actor.destroy();
  });

  it('destroy tears the session down', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({ source: makeSource(), createTransport: makeCreateTransport(fake) });
    fake.sendServerSetup();
    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('ready'));

    actor.destroy();
    expect(fake.getCloseInfo()).toBeDefined();
  });

  describe('reconnect', () => {
    // Backoff delays are jittered ±25%, so these tests advance well past a
    // delay rather than by its exact value.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Yield a macrotask so the connect chain's promises settle; no timer fires. */
    const settle = () => vi.advanceTimersByTimeAsync(0);

    it('retries a failed connect after a backoff delay instead of failing', async () => {
      const failing = createFakeTransport();
      const recovered = createFakeTransport();
      let attempts = 0;
      const createTransport = vi.fn<CreateMoqTransport>(() =>
        ++attempts === 1
          ? { transport: failing.transport, ready: Promise.reject(new Error('handshake failed')) }
          : { transport: recovered.transport, ready: Promise.resolve() }
      );

      const actor = createMoqSessionActor({ source: makeSource(), createTransport });
      await settle();

      // Default policy retries forever: a first failure is an outage, not the end.
      expect(actor.snapshot.get().context.status).toBe('reconnecting');
      expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);
      expect(actor.snapshot.get().context.session).toBeUndefined();
      expect(createTransport).toHaveBeenCalledTimes(1);

      recovered.sendServerSetup();
      await vi.advanceTimersByTimeAsync(1000); // 2× the 500ms default first delay

      expect(createTransport).toHaveBeenCalledTimes(2);
      expect(actor.snapshot.get().context.status).toBe('ready');
      expect(actor.snapshot.get().context.session).toBeDefined();
      // The recovered connection publishes a clean context, not the old failure.
      expect(actor.snapshot.get().context.error).toBeUndefined();

      actor.destroy();
    });

    it('re-fetches the auth token for each reconnect attempt', async () => {
      // A relay outage outlasting the token's lifetime must not reconnect
      // with the expired one.
      const failing = createFakeTransport();
      const recovered = createFakeTransport();
      let attempts = 0;
      const createTransport = vi.fn<CreateMoqTransport>(() =>
        ++attempts === 1
          ? { transport: failing.transport, ready: Promise.reject(new Error('handshake failed')) }
          : { transport: recovered.transport, ready: Promise.resolve() }
      );
      const getToken = vi.fn(() => (attempts === 0 ? 'first' : 'second'));

      const actor = createMoqSessionActor({ source: makeSource(), createTransport, authProvider: { getToken } });
      await settle();
      expect(getToken).toHaveBeenCalledTimes(1);

      recovered.sendServerSetup();
      await vi.advanceTimersByTimeAsync(1000);

      expect(getToken).toHaveBeenCalledTimes(2);
      expect(actor.getAuthParameters().authorizationTokens?.[0]).toEqual(
        new Uint8Array([0x3, 0x0, ...new TextEncoder().encode('second')])
      );

      actor.destroy();
    });

    it('reconnects with a new session when an established transport drops', async () => {
      const first = createFakeTransport();
      const second = createFakeTransport();
      let attempts = 0;
      const createTransport = vi.fn<CreateMoqTransport>(() => ({
        transport: (++attempts === 1 ? first : second).transport,
        ready: Promise.resolve(),
      }));

      const actor = createMoqSessionActor({ source: makeSource(), createTransport });
      first.sendServerSetup();
      await settle();
      expect(actor.snapshot.get().context.status).toBe('ready');
      const firstSession = actor.snapshot.get().context.session;

      first.drop();
      await settle();

      // The dead session leaves the context so nothing issues requests on it.
      expect(actor.snapshot.get().context.status).toBe('reconnecting');
      expect(actor.snapshot.get().context.session).toBeUndefined();

      second.sendServerSetup();
      await vi.advanceTimersByTimeAsync(1000);

      expect(createTransport).toHaveBeenCalledTimes(2);
      expect(actor.snapshot.get().context.status).toBe('ready');
      // Behaviors keyed on 'ready' re-subscribe against this new session.
      expect(actor.snapshot.get().context.session).toBeDefined();
      expect(actor.snapshot.get().context.session).not.toBe(firstSession);

      actor.destroy();
    });

    it('fails once the retry budget is spent and never retries again', async () => {
      // The transport object is irrelevant here — every attempt rejects
      // before a session exists.
      const fake = createFakeTransport();
      const createTransport = vi.fn<CreateMoqTransport>(() => ({
        transport: fake.transport,
        ready: Promise.reject(new Error('handshake failed')),
      }));

      const actor = createMoqSessionActor({
        source: makeSource(),
        createTransport,
        reconnect: { maxAttempts: 1, initialDelayMs: 10 },
      });
      await settle();
      expect(actor.snapshot.get().context.status).toBe('reconnecting');
      expect(createTransport).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(createTransport).toHaveBeenCalledTimes(2);
      expect(actor.snapshot.get().context.status).toBe('failed');
      expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);

      // 'failed' is terminal: the spent budget schedules nothing more.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(createTransport).toHaveBeenCalledTimes(2);

      actor.destroy();
    });

    it('does not retry after destroy while reconnecting', async () => {
      const fake = createFakeTransport();
      const createTransport = vi.fn<CreateMoqTransport>(() => ({
        transport: fake.transport,
        ready: Promise.reject(new Error('handshake failed')),
      }));

      const actor = createMoqSessionActor({ source: makeSource(), createTransport });
      await settle();
      expect(actor.snapshot.get().context.status).toBe('reconnecting');

      actor.destroy();
      await vi.advanceTimersByTimeAsync(60_000);

      // destroy() cleared the pending timer; a destroyed actor never reconnects.
      expect(createTransport).toHaveBeenCalledTimes(1);
    });
  });
});
