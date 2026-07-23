import { describe, expect, it, vi } from 'vitest';
import { type MoqAudioContext, MoqMediaElement } from '../adapter';

/**
 * Structural `MoqAudioContext` fake: tracks state transitions through
 * resume/suspend spies so tests can assert the adapter's paused-flag
 * alignment without a live audio device.
 */
function createFakeAudioContext(initialState: AudioContextState) {
  const fake = {
    state: initialState,
    currentTime: 0,
    destination: {} as AudioNode,
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
    expect(media.engine.context.audioContext.get()).toBe(audioContext);

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
});
