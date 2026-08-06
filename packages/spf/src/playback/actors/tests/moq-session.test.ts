import { describe, expect, it, vi } from 'vitest';
import type { MoqSource } from '../../../media/moq/parse-source';
import { encodeSetup } from '../../../network/moqt/control-messages';
import type { MoqtTransport } from '../../../network/moqt/session';
import { type CreateMoqTransport, composePlaybackConnectUrl, createMoqSessionActor } from '../moq-session';

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

  it('fails when the transport cannot connect, closing the half-open transport', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport: () => ({
        transport: fake.transport,
        ready: Promise.reject(new Error('handshake failed')),
      }),
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

  // The known relay fleet (moq-lite-rs lineage) hard-closes the session on
  // draft-19 AUTHORIZATION_TOKEN structures — the token must ride ONLY in
  // the connect URL's `?jwt=` query parameter, matching the publish side's
  // `composePublishConnectUrl` fix.
  it('composes the c4m fragment token onto the connect URL as ?jwt=, keeping auth parameters empty', () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'abc' }),
      createTransport: makeCreateTransport(fake),
    });

    expect(makeCreateTransport.lastConnect?.connectUrl).toBe('https://relay.example.com/live?jwt=abc');
    expect(actor.getAuthParameters()).toEqual({});

    actor.destroy();
  });

  it('prefers the auth provider token over the c4m fragment token', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'stale' }),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken: () => 'fresh', tokenType: 2 },
    });

    await vi.waitFor(() => {
      expect(makeCreateTransport.lastConnect?.connectUrl).toBe('https://relay.example.com/live?jwt=fresh');
    });
    expect(actor.getAuthParameters()).toEqual({});

    actor.destroy();
  });

  it('skips token resolution entirely when the source URL carries an explicit jwt', async () => {
    // The explicit URL token wins (composePlaybackConnectUrl leaves the
    // URL untouched), so the provider must not even be consulted: a
    // minted token would only be discarded, and a provider failure must
    // not block a connect that already carries its credentials.
    const fake = createFakeTransport();
    const getToken = vi.fn(() => {
      throw new Error('provider exploded');
    });
    const actor = createMoqSessionActor({
      source: makeSource({ connectUrl: 'https://relay.example.com/live?jwt=mine', c4mToken: 'ignored' }),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken },
    });

    fake.sendServerSetup();
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    expect(makeCreateTransport.lastConnect?.connectUrl).toBe('https://relay.example.com/live?jwt=mine');
    expect(getToken).not.toHaveBeenCalled();

    actor.destroy();
  });

  it('skips token resolution for an unparseable URL so the URL error survives a failing provider', async () => {
    // composePlaybackConnectUrl cannot attach a token to a URL it cannot
    // parse, so resolving one is wasted work — and a throwing provider
    // would replace the canonical `new WebTransport(url)` failure with an
    // auth error, hiding the real fault (a malformed connect URL).
    const fake = createFakeTransport();
    const getToken = vi.fn(() => {
      throw new Error('provider exploded');
    });
    const actor = createMoqSessionActor({
      source: makeSource({ connectUrl: 'not a url', c4mToken: 'ignored' }),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken },
    });

    fake.sendServerSetup();
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    expect(makeCreateTransport.lastConnect?.connectUrl).toBe('not a url');
    expect(getToken).not.toHaveBeenCalled();

    actor.destroy();
  });

  // The actor connects exactly once (no reconnect path — a goaway is only
  // recorded), so a refreshed token would have no connection left to
  // attach to: the jwt is fixed at connect time. Rejecting must happen
  // without ever calling the provider, or a retry costs a real round-trip
  // (and, for a minting-backed provider, a real token) for a value
  // guaranteed to go unused.
  it('rejects refreshAuthToken without calling the provider, even when it could supply a fresh token', async () => {
    const fake = createFakeTransport();
    const refreshToken = vi.fn(() => 'refreshed');
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'stale' }),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken: () => 'stale', refreshToken },
    });

    await expect(actor.refreshAuthToken()).rejects.toThrow(/does not reconnect/);
    expect(refreshToken).not.toHaveBeenCalled();

    actor.destroy();
  });

  it('rejects refreshAuthToken without an auth provider', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource({ c4mToken: 'abc' }),
      createTransport: makeCreateTransport(fake),
    });

    await expect(actor.refreshAuthToken()).rejects.toThrow(/does not reconnect/);

    actor.destroy();
  });

  // toTokenString decodes with a fatal UTF-8 decoder so a binary token
  // (e.g. a CBOR-encoded CAT token, which `getToken` can legitimately
  // return as raw bytes) fails loudly instead of riding a substituted
  // (corrupted) value to the relay. The decode happens inside start()'s
  // try — see the CRITICAL note in this actor's review fix — so the
  // failure lands as a 'failed' snapshot rather than escaping the
  // synchronous createMoqSessionActor() call.
  it('fails with a descriptive error when the auth provider supplies a non-UTF-8 binary token', async () => {
    const createTransport = vi.fn(makeCreateTransport(createFakeTransport()));
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport,
      // A lone 0xff byte is invalid UTF-8 under every interpretation.
      authProvider: { getToken: () => new Uint8Array([0xff]) },
    });

    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('failed'));
    expect(String(actor.snapshot.get().context.error)).toMatch(/binary/);
    expect(String(actor.snapshot.get().context.error)).toMatch(/\?jwt=/);
    // The decode failure preempts connecting entirely.
    expect(createTransport).not.toHaveBeenCalled();

    actor.destroy();
  });

  it('composes a valid UTF-8 Uint8Array auth-provider token onto the connect URL as ?jwt=', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport: makeCreateTransport(fake),
      authProvider: { getToken: () => new TextEncoder().encode('fresh-token') },
    });

    await vi.waitFor(() => {
      expect(makeCreateTransport.lastConnect?.connectUrl).toBe('https://relay.example.com/live?jwt=fresh-token');
    });

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
});

describe('composePlaybackConnectUrl', () => {
  it('appends the token as a jwt query parameter (moq-lite-rs convention)', () => {
    expect(composePlaybackConnectUrl('https://relay.example.com:4443', 'tok')).toBe(
      'https://relay.example.com:4443/?jwt=tok'
    );
    expect(composePlaybackConnectUrl('https://relay.example.com/moq?keep=1', 'tok')).toBe(
      'https://relay.example.com/moq?keep=1&jwt=tok'
    );
  });

  it('leaves the URL alone without a token or with an explicit jwt parameter', () => {
    expect(composePlaybackConnectUrl('https://relay.example.com/moq')).toBe('https://relay.example.com/moq');
    expect(composePlaybackConnectUrl('https://relay.example.com/?jwt=mine', 'tok')).toBe(
      'https://relay.example.com/?jwt=mine'
    );
  });

  it('returns an unparseable URL verbatim so WebTransport raises the canonical error', () => {
    expect(composePlaybackConnectUrl('not a url', 'tok')).toBe('not a url');
  });
});
