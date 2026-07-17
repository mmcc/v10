import { describe, expect, it, vi } from 'vitest';
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
      closeInfo = info;
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

  it('fails when the transport cannot connect', async () => {
    const actor = createMoqSessionActor({
      source: makeSource(),
      createTransport: () => ({
        transport: createFakeTransport().transport,
        ready: Promise.reject(new Error('handshake failed')),
      }),
    });

    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('failed'));
    expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);

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

  it('destroy tears the session down', async () => {
    const fake = createFakeTransport();
    const actor = createMoqSessionActor({ source: makeSource(), createTransport: makeCreateTransport(fake) });
    fake.sendServerSetup();
    await vi.waitFor(() => expect(actor.snapshot.get().context.status).toBe('ready'));

    actor.destroy();
    expect(fake.getCloseInfo()).toBeDefined();
  });
});
