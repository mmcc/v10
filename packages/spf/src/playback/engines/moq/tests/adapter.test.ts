import { describe, expect, it, vi } from 'vitest';
import { type MoqAudioContext, MoqMediaElement } from '../adapter';

/**
 * Structural `MoqAudioContext` fake: tracks state transitions through
 * resume/suspend spies so tests can assert the adapter's paused-flag
 * alignment without a live audio device.
 */
function createFakeGain() {
  return {
    connect: vi.fn(),
    gain: { value: 1 },
  } as unknown as GainNode & { connect: ReturnType<typeof vi.fn>; gain: { value: number } };
}

function createFakeAudioContext(initialState: AudioContextState) {
  const gain = createFakeGain();
  const fake = {
    state: initialState,
    currentTime: 0,
    destination: {} as AudioNode,
    gain,
    createGain: vi.fn(() => gain),
    createBuffer: (() => {
      throw new Error('unused in adapter tests');
    }) as MoqAudioContext['createBuffer'],
    createBufferSource: (() => {
      throw new Error('unused in adapter tests');
    }) as MoqAudioContext['createBufferSource'],
    resume: vi.fn(async () => {
      fake.state = 'running';
    }),
    suspend: vi.fn(async () => {
      fake.state = 'suspended';
    }),
    close: vi.fn(async () => {
      fake.state = 'closed';
    }),
  };
  return fake;
}

describe('MoqMediaMixin', () => {
  it('resumes the context on attach() when play() ran before attach()', async () => {
    // Outside a user gesture a new AudioContext starts 'suspended'.
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    // play() before attach(): no context exists yet, so there is nothing
    // to resume — attach() must pick the alignment up.
    await media.play();
    expect(audioContext.resume).not.toHaveBeenCalled();

    media.attach(document.createElement('canvas'));
    expect(audioContext.resume).toHaveBeenCalledTimes(1);
    // The engine sees a render-facing view whose destination is the gain
    // node (volume path), delegating the clock to the real context.
    const renderContext = media.engine.context.audioContext.get();
    expect(renderContext?.destination).toBe(audioContext.gain);
    expect(audioContext.gain.connect).toHaveBeenCalledWith(audioContext.destination);
    expect(renderContext?.currentTime).toBe(audioContext.currentTime);

    media.destroy();
  });

  it('suspends a running context on attach() while paused', () => {
    // Inside a user gesture a new AudioContext can start 'running'.
    const audioContext = createFakeAudioContext('running');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    expect(media.paused).toBe(true);
    media.attach(document.createElement('canvas'));
    expect(audioContext.suspend).toHaveBeenCalledTimes(1);
    expect(audioContext.resume).not.toHaveBeenCalled();

    media.destroy();
  });

  it('writes the engine paused slot from play()/pause()', async () => {
    const media = new MoqMediaElement({ createAudioContext: () => createFakeAudioContext('suspended') });

    // Unset slot reads as paused on the facade but leaves engine-only
    // drivers (which never write it) playing.
    expect(media.engine.state.paused.get()).toBeUndefined();
    expect(media.paused).toBe(true);

    await media.play();
    expect(media.engine.state.paused.get()).toBe(false);
    expect(media.paused).toBe(false);

    media.pause();
    expect(media.engine.state.paused.get()).toBe(true);
    expect(media.paused).toBe(true);

    media.destroy();
  });

  it('applies volume and muted to the render gain, including values set before attach()', () => {
    const audioContext = createFakeAudioContext('running');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    expect(media.volume).toBe(1);
    expect(media.muted).toBe(false);

    // Pre-attach: no gain node exists yet — values must apply on attach.
    media.volume = 0.5;
    media.attach(document.createElement('canvas'));
    expect(audioContext.gain.gain.value).toBe(0.5);

    media.muted = true;
    expect(audioContext.gain.gain.value).toBe(0);

    media.muted = false;
    expect(audioContext.gain.gain.value).toBe(0.5);

    media.volume = 2;
    expect(media.volume).toBe(1);
    expect(audioContext.gain.gain.value).toBe(1);

    media.destroy();
  });

  it('forwards engineConfig to the engine', async () => {
    const createMoqTransport = vi.fn((_connectUrl: string, _protocols: string[]) => ({
      // Never delivers server SETUP: the factory call is what's under test.
      transport: {
        incomingUnidirectionalStreams: new ReadableStream<ReadableStream<Uint8Array>>({ start() {} }),
        incomingBidirectionalStreams: new ReadableStream({ start() {} }),
        createUnidirectionalStream: async () => new WritableStream<Uint8Array>(),
        createBidirectionalStream: async () => ({
          readable: new ReadableStream<Uint8Array>({ start() {} }),
          writable: new WritableStream<Uint8Array>(),
        }),
        close: () => {},
        closed: new Promise<void>(() => {}),
      },
      ready: Promise.resolve(),
    }));

    const media = new MoqMediaElement({
      createAudioContext: () => createFakeAudioContext('running'),
      engineConfig: { createMoqTransport },
    });

    // `preload: 'auto'` opens the session behavior's load gate without an
    // element to activate it.
    media.preload = 'auto';
    media.src = 'moqt://relay.test/live#msf:live--catalog';

    await vi.waitFor(() => expect(createMoqTransport).toHaveBeenCalledTimes(1));
    // moqt: → https: with the fragment stripped (moq-transport §3.1.4).
    expect(createMoqTransport.mock.calls[0]?.[0]).toBe('https://relay.test/live');
    // The adapter's own `onSignalsReady` survived the config spread.
    expect(media.engine.state.presentation.get()?.url).toBe('moqt://relay.test/live#msf:live--catalog');

    media.destroy();
  });
});
