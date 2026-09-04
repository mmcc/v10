import { describe, expect, it, vi } from 'vite-plus/test';

import { type MoqAudioContext, MoqMediaElement } from '../adapter';

/**
 * Structural `MoqAudioContext` fake: tracks state transitions through resume/suspend spies so tests can assert the
 * adapter's paused-flag alignment without a live audio device.
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

  it('restores paused when resume() rejects, so a blocked play() is not reported as playing', async () => {
    const audioContext = createFakeAudioContext('suspended');

    audioContext.resume.mockRejectedValueOnce(new Error('NotAllowedError'));
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    await expect(media.play()).rejects.toThrow('NotAllowedError');
    expect(media.paused).toBe(true);
    expect(media.engine.state.paused.get()).toBe(true);
    // play() is still the load intent — a silent audio device must not leave
    // the engine unable to load at all.
    expect(media.engine.state.loadActivated.get()).toBe(true);

    media.destroy();
  });

  it('closes the load gate and suspends audio on a src change', async () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    await media.play();
    expect(media.engine.state.loadActivated.get()).toBe(true);
    audioContext.suspend.mockClear();

    media.src = 'moqt://relay.test/other#msf:live--catalog';
    // Otherwise one earlier play() makes every later src bypass `preload`.
    expect(media.engine.state.loadActivated.get()).toBe(false);
    expect(media.engine.state.paused.get()).toBe(true);
    // The audio renderer has no rate-0 gate, so the suspend *is* the pause.
    expect(audioContext.suspend).toHaveBeenCalledTimes(1);

    media.destroy();
  });

  it('closes the audio context only after the engine has torn down', async () => {
    const audioContext = createFakeAudioContext('running');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.destroy();
    // Renderer ticks still call createBuffer/createBufferSource until the
    // composition has stopped them; closing first throws InvalidStateError.
    expect(audioContext.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(audioContext.close).toHaveBeenCalledTimes(1));
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

  it('ignores a NaN volume write so a non-finite gain never reaches the audio graph', () => {
    const audioContext = createFakeAudioContext('running');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.volume = 0.5;
    // Web Audio rejects a non-finite gain value with a TypeError — the
    // facade drops the write and keeps the last valid volume.
    media.volume = Number.NaN;
    expect(media.volume).toBe(0.5);
    expect(audioContext.gain.gain.value).toBe(0.5);

    // The infinities clamp to the documented [0, 1] range on their own.
    media.volume = Number.POSITIVE_INFINITY;
    expect(media.volume).toBe(1);
    media.volume = Number.NEGATIVE_INFINITY;
    expect(media.volume).toBe(0);
    expect(audioContext.gain.gain.value).toBe(0);

    media.destroy();
  });

  // Tri-state, the same shape `targetLatency` has: the engine reads
  // `undefined` as *unstated* and defers to `adaptiveLatency.enabled`, so a
  // facade that collapsed it to `false` reported adaptation off while it was
  // running and could never hand the decision back to config.
  it('keeps the adaptive-latency request unstated until something states it', () => {
    const media = new MoqMediaElement({
      createAudioContext: () => createFakeAudioContext('running'),
      engineConfig: { adaptiveLatency: { enabled: true } },
    });

    expect(media.adaptiveLatency).toBeUndefined();
    expect(media.engine.state.adaptiveLatencyEnabled.get()).toBeUndefined();

    media.adaptiveLatency = false;
    expect(media.adaptiveLatency).toBe(false);
    expect(media.engine.state.adaptiveLatencyEnabled.get()).toBe(false);

    media.adaptiveLatency = undefined;
    expect(media.adaptiveLatency).toBeUndefined();
    expect(media.engine.state.adaptiveLatencyEnabled.get()).toBeUndefined();

    media.destroy();
  });

  it('starts playback from autoplay and defers audio while the context is suspended', async () => {
    const audioContext = createFakeAudioContext('suspended');
    // Chromium's pre-gesture shape: resume() parks until user activation.
    let activate!: () => void;

    audioContext.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          activate = () => {
            audioContext.state = 'running';
            resolve();
          };
        })
    );
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';

    // Playback intent applies in full — video renders on the self-clock —
    // while the audio subscription waits behind the policy gate.
    expect(media.paused).toBe(false);
    expect(media.engine.state.loadActivated.get()).toBe(true);
    expect(media.engine.state.audioSuspended.get()).toBe(true);

    // The queued resume settling at user activation is the unlock. It is
    // issued once the src-change suspend has been acknowledged.
    await vi.waitFor(() => expect(audioContext.resume).toHaveBeenCalledTimes(1));
    activate();
    await vi.waitFor(() => expect(media.engine.state.audioSuspended.get()).toBeUndefined());
    expect(media.paused).toBe(false);

    media.destroy();
  });

  it('defers audio for an autoplay that ran before attach() and unlocks via the alignment resume', async () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    expect(media.paused).toBe(false);
    expect(media.engine.state.audioSuspended.get()).toBe(true);
    expect(audioContext.resume).not.toHaveBeenCalled();

    // attach() aligns the fresh context with the playing state; the fake
    // resume resolves (a permitted context), which settles the deferral.
    media.attach(document.createElement('canvas'));
    expect(audioContext.resume).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(media.engine.state.audioSuspended.get()).toBeUndefined());

    media.destroy();
  });

  it('settles a pre-attach autoplay deferral when the context arrives running', () => {
    const audioContext = createFakeAudioContext('running');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    expect(media.engine.state.audioSuspended.get()).toBe(true);

    // A running context (created inside a gesture) can always render audio.
    media.attach(document.createElement('canvas'));
    expect(media.engine.state.audioSuspended.get()).toBeUndefined();
    expect(audioContext.suspend).not.toHaveBeenCalled();

    media.destroy();
  });

  it('keeps audio deferred after a rejected pre-gesture resume until play() succeeds', async () => {
    const audioContext = createFakeAudioContext('suspended');

    // Safari's shape: a pre-gesture resume() rejects outright.
    audioContext.resume.mockRejectedValueOnce(new Error('NotAllowedError'));
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(media.engine.state.audioSuspended.get()).toBe(true);
    // The rejection must not pause the deferred playback — video plays on.
    expect(media.paused).toBe(false);

    // A gesture-driven play(): the default fake resume now succeeds.
    await media.play();
    expect(media.engine.state.audioSuspended.get()).toBeUndefined();
    expect(media.paused).toBe(false);

    media.destroy();
  });

  it('attempts autoplay once per load cycle and never restarts an explicit pause', () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    expect(media.paused).toBe(false);

    media.pause();
    // Toggling the flag after playback started (spec: pause() clears the
    // can-autoplay flag) must not restart the player.
    media.autoplay = false;
    media.autoplay = true;
    expect(media.paused).toBe(true);

    // A new load cycle re-arms the attempt.
    media.src = 'moqt://relay.test/other#msf:live--catalog';
    expect(media.paused).toBe(false);

    media.destroy();
  });

  it('begins playback when autoplay is enabled after the source', () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.src = 'moqt://relay.test/live#msf:live--catalog';
    expect(media.paused).toBe(true);

    media.autoplay = true;
    expect(media.paused).toBe(false);
    expect(media.engine.state.loadActivated.get()).toBe(true);

    media.destroy();
  });

  it('chains play() behind a pending src-change suspend instead of trusting the stale running state', async () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    await media.play();
    expect(audioContext.state).toBe('running');
    expect(audioContext.resume).toHaveBeenCalledTimes(1);

    // Real contexts only flip `state` once the control thread acknowledges
    // — model the src-change suspend as in flight with a stale 'running'.
    let ackSuspend!: () => void;

    audioContext.suspend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ackSuspend = () => {
            audioContext.state = 'suspended';
            resolve();
          };
        })
    );
    media.src = 'moqt://relay.test/other#msf:live--catalog';
    expect(audioContext.state).toBe('running'); // suspend not yet acknowledged

    const playing = media.play();

    await Promise.resolve();
    // The resume waits for the suspend ack rather than reading the stale
    // state and skipping — a skipped resume would leave the context
    // suspended while the facade reports playing.
    expect(audioContext.resume).toHaveBeenCalledTimes(1);
    ackSuspend();
    await playing;
    expect(audioContext.resume).toHaveBeenCalledTimes(2);
    expect(audioContext.state).toBe('running');
    expect(media.paused).toBe(false);

    media.destroy();
  });

  it('defers audio and chains the autoplay resume behind a pending src-change suspend', async () => {
    const audioContext = createFakeAudioContext('suspended');
    const media = new MoqMediaElement({ createAudioContext: () => audioContext });

    media.attach(document.createElement('canvas'));

    media.autoplay = true;
    media.src = 'moqt://relay.test/live#msf:live--catalog';
    await vi.waitFor(() => expect(media.engine.state.audioSuspended.get()).toBeUndefined());
    expect(audioContext.state).toBe('running');

    let ackSuspend!: () => void;

    audioContext.suspend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ackSuspend = () => {
            audioContext.state = 'suspended';
            resolve();
          };
        })
    );
    media.src = 'moqt://relay.test/other#msf:live--catalog';

    // Playback intent applies while the suspend is still in flight; the
    // stale 'running' state must not skip the deferral + queued resume.
    expect(media.paused).toBe(false);
    expect(media.engine.state.audioSuspended.get()).toBe(true);
    const resumeCalls = audioContext.resume.mock.calls.length;

    ackSuspend();
    await vi.waitFor(() => expect(media.engine.state.audioSuspended.get()).toBeUndefined());
    expect(audioContext.resume.mock.calls.length).toBe(resumeCalls + 1);
    expect(audioContext.state).toBe('running');

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
