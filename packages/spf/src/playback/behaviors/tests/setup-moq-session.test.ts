import { describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { MaybeResolvedPresentation } from '../../../media/types';
import { encodeSetup } from '../../../network/moqt/control-messages';
import type { MoqtTransport } from '../../../network/moqt/session';
import type { MoqSessionActor } from '../../actors/moq-session';
import { setupMoqSession } from '../setup-moq-session';

const MOQ_URL = 'moqt://relay.example.com/live#msf:live--catalog';

function makeDeps(initial: { presentation?: MaybeResolvedPresentation; preload?: 'auto' | 'metadata' | 'none' } = {}) {
  const state = {
    presentation: signal<MaybeResolvedPresentation | undefined>(initial.presentation),
    preload: signal<'auto' | 'metadata' | 'none' | undefined>(initial.preload),
    loadActivated: signal<boolean | undefined>(undefined),
  };
  const context = { moqSessionActor: signal<MoqSessionActor | undefined>(undefined) };
  return { state, context };
}

function fakeTransportFactory() {
  const connects: string[] = [];
  const createMoqTransport = (connectUrl: string) => {
    connects.push(connectUrl);
    const transport: MoqtTransport = {
      incomingUnidirectionalStreams: new ReadableStream({
        start(controller) {
          const pipe = new TransformStream<Uint8Array, Uint8Array>();
          void pipe.writable.getWriter().write(encodeSetup([]));
          controller.enqueue(pipe.readable);
        },
      }),
      incomingBidirectionalStreams: new ReadableStream({ start() {} }),
      createUnidirectionalStream: async () => new WritableStream<Uint8Array>(),
      createBidirectionalStream: async () => ({
        readable: new ReadableStream<Uint8Array>({ start() {} }),
        writable: new WritableStream<Uint8Array>(),
      }),
      close: () => {},
      closed: new Promise(() => {}),
    };
    return { transport, ready: Promise.resolve() };
  };
  return { createMoqTransport, connects };
}

describe('setupMoqSession', () => {
  it('creates and publishes the session actor once a moqt source and open gate are present', async () => {
    const { state, context } = makeDeps({ preload: 'auto' });
    const { createMoqTransport, connects } = fakeTransportFactory();
    const reactor = setupMoqSession.setup({ state, context, config: { createMoqTransport } });

    expect(context.moqSessionActor.get()).toBeUndefined();

    state.presentation.set({ url: MOQ_URL });
    await vi.waitFor(() => expect(context.moqSessionActor.get()).toBeDefined());
    expect(connects).toEqual(['https://relay.example.com/live']);

    reactor.destroy();
    expect(context.moqSessionActor.get()).toBeUndefined();
  });

  it('gates on preload=none until load activation', async () => {
    const { state, context } = makeDeps({ presentation: { url: MOQ_URL }, preload: 'none' });
    const { createMoqTransport } = fakeTransportFactory();
    const reactor = setupMoqSession.setup({ state, context, config: { createMoqTransport } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(context.moqSessionActor.get()).toBeUndefined();

    state.loadActivated.set(true);
    await vi.waitFor(() => expect(context.moqSessionActor.get()).toBeDefined());

    reactor.destroy();
  });

  it('ignores non-moqt sources', async () => {
    const { state, context } = makeDeps({
      presentation: { url: 'https://example.com/live.m3u8' },
      preload: 'auto',
    });
    const { createMoqTransport } = fakeTransportFactory();
    const reactor = setupMoqSession.setup({ state, context, config: { createMoqTransport } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(context.moqSessionActor.get()).toBeUndefined();

    reactor.destroy();
  });

  it('tears down and rebuilds the session on source change', async () => {
    const { state, context } = makeDeps({ presentation: { url: MOQ_URL }, preload: 'auto' });
    const { createMoqTransport, connects } = fakeTransportFactory();
    const reactor = setupMoqSession.setup({ state, context, config: { createMoqTransport } });

    await vi.waitFor(() => expect(context.moqSessionActor.get()).toBeDefined());
    const firstActor = context.moqSessionActor.get();

    state.presentation.set({ url: 'moqt://relay2.example.com/live#msf:live--catalog' });
    await vi.waitFor(() => {
      const actor = context.moqSessionActor.get();
      expect(actor).toBeDefined();
      expect(actor).not.toBe(firstActor);
    });
    expect(connects).toHaveLength(2);

    reactor.destroy();
  });
});
