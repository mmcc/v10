import type { MoqAudioContext } from '@videojs/spf/moq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleMoqVideo } from '../index';

function createFakeAudioContext(initialState: AudioContextState) {
  const fake = {
    state: initialState,
    currentTime: 0,
    destination: {} as AudioNode,
    createGain: () =>
      ({
        connect: () => {},
        gain: { value: 1 },
      }) as unknown as GainNode,
    createBuffer: (() => {
      throw new Error('unused in wrapper tests');
    }) as MoqAudioContext['createBuffer'],
    createBufferSource: (() => {
      throw new Error('unused in wrapper tests');
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

let tagCounter = 0;

function defineElement() {
  const tag = `test-simple-moq-video-${++tagCounter}`;
  customElements.define(
    tag,
    class extends SimpleMoqVideo {
      constructor() {
        super({ createAudioContext: () => createFakeAudioContext('suspended') });
      }
    }
  );
  return tag;
}

function createConnectedElement() {
  const el = document.createElement(defineElement()) as SimpleMoqVideo;
  document.body.append(el);
  return el;
}

/** Flush the signal-effect microtask queue. */
function flushEffects() {
  return new Promise((resolve) => queueMicrotask(resolve as () => void));
}

function recordEvents(el: EventTarget, types: string[]) {
  const events: string[] = [];
  for (const type of types) {
    el.addEventListener(type, () => events.push(type));
  }
  return events;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('SimpleMoqVideo', () => {
  it('renders a canvas into its shadow root', () => {
    const tag = defineElement();
    const el = document.createElement(tag) as SimpleMoqVideo;

    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });

  it('sizes the canvas from a stylesheet so skin style hooks apply', () => {
    const tag = defineElement();
    const el = document.createElement(tag) as SimpleMoqVideo;

    // Inline styles would win over the skin's CSS vars; the canvas must be
    // styled by the sheet, and the host must generate no box so the canvas
    // fills the skin's media container like a slotted `<video>` does.
    const canvas = el.shadowRoot!.querySelector('canvas')!;
    expect(canvas.getAttribute('style')).toBeNull();

    const styles = el.shadowRoot!.querySelector('style')!.textContent!;
    expect(styles).toContain('display: contents');
    expect(styles).toContain('object-fit: var(--media-object-fit, contain)');
    expect(styles).toContain('border-radius: var(--media-video-border-radius)');
  });

  it('attaches the canvas as the render surface on connect', () => {
    const el = createConnectedElement();

    const canvas = el.shadowRoot!.querySelector('canvas');
    expect((el as any).engine.context.renderSurface.get()).toBe(canvas);
  });

  it('reflects the src attribute onto the moq presentation state', () => {
    const el = createConnectedElement();

    el.setAttribute('src', 'moqt://relay.example.com/live#msf:live--catalog');

    expect(el.src).toBe('moqt://relay.example.com/live#msf:live--catalog');
    expect((el as any).engine.state.presentation.get()).toEqual({
      url: 'moqt://relay.example.com/live#msf:live--catalog',
    });
  });

  it('reflects the target-latency attribute onto the targetLatency property', () => {
    const el = createConnectedElement();

    el.setAttribute('target-latency', '1.5');

    expect(el.targetLatency).toBe(1.5);
  });

  it('destroys the engine once actually disconnected', async () => {
    const el = createConnectedElement();

    const destroy = vi.spyOn(el, 'destroy');
    el.remove();
    await new Promise((resolve) => queueMicrotask(resolve as () => void));

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  describe('event bridge', () => {
    it('dispatches the native load cycle on src transitions', () => {
      const el = createConnectedElement();
      const events = recordEvents(el, [
        'loadstart',
        'emptied',
        'durationchange',
        'streamtypechange',
        'targetlivewindowchange',
      ]);

      el.src = 'moqt://relay.example.com/live#msf:live--catalog';
      expect(events).toEqual(['loadstart', 'durationchange', 'streamtypechange', 'targetlivewindowchange']);

      events.length = 0;
      el.src = '';
      expect(events).toEqual(['emptied', 'durationchange', 'streamtypechange', 'targetlivewindowchange']);
    });

    it('dispatches play and pause from engine paused transitions', async () => {
      const el = createConnectedElement();
      const events = recordEvents(el, ['play', 'pause']);

      await el.play();
      await flushEffects();
      expect(events).toEqual(['play']);

      el.pause();
      await flushEffects();
      expect(events).toEqual(['play', 'pause']);
    });

    it('dispatches loadedmetadata and durationchange when the presentation resolves', async () => {
      const el = createConnectedElement();
      const events = recordEvents(el, ['loadedmetadata', 'durationchange']);

      (el as any).engine.state.presentation.set({
        url: 'moqt://relay.example.com/live#msf:live--catalog',
        id: 'presentation',
        selectionSets: [],
      });
      await flushEffects();

      expect(events).toEqual(['loadedmetadata', 'durationchange']);
      expect(el.readyState).toBe(1);
    });

    it('dispatches timeupdate/playing while the clock advances and waiting on stall', async () => {
      vi.useFakeTimers();
      const el = createConnectedElement();
      const events = recordEvents(el, ['canplay', 'canplaythrough', 'playing', 'timeupdate', 'waiting']);

      await el.play();

      (el as any).engine.state.currentTime.set(0.5);
      await vi.advanceTimersByTimeAsync(250);
      expect(events).toEqual(['canplay', 'canplaythrough', 'playing', 'timeupdate']);
      expect(el.readyState).toBe(4);

      // Clock frozen while playing — jitter buffer ran dry.
      await vi.advanceTimersByTimeAsync(250);
      expect(events).toContain('waiting');
      expect(el.readyState).toBe(2);

      // Clock resumes — playing again.
      events.length = 0;
      (el as any).engine.state.currentTime.set(1.0);
      await vi.advanceTimersByTimeAsync(250);
      expect(events).toEqual(['canplay', 'canplaythrough', 'playing', 'timeupdate']);
    });

    it('does not poll for timeupdate while paused', async () => {
      vi.useFakeTimers();
      const el = createConnectedElement();
      const events = recordEvents(el, ['timeupdate', 'waiting']);

      (el as any).engine.state.currentTime.set(0.5);
      await vi.advanceTimersByTimeAsync(500);

      expect(events).toEqual([]);
    });

    it('dispatches volumechange when volume or muted change', () => {
      const el = createConnectedElement();
      const events = recordEvents(el, ['volumechange']);

      el.volume = 0.5;
      el.muted = true;
      el.muted = true;
      el.volume = 0.5;

      expect(events).toEqual(['volumechange', 'volumechange']);
      expect(el.volume).toBe(0.5);
      expect(el.muted).toBe(true);
    });

    it('resolves seek flows immediately with a deferred seeked event', async () => {
      const el = createConnectedElement();
      const events = recordEvents(el, ['seeked']);

      el.currentTime = 42;
      expect(events).toEqual([]);
      await flushEffects();

      expect(events).toEqual(['seeked']);
      expect(el.seeking).toBe(false);
    });
  });

  describe('capability surface', () => {
    it('exposes the pause, seek, and source capability properties', () => {
      const el = createConnectedElement();

      expect(el.paused).toBe(true);
      expect(el.ended).toBe(false);
      expect(el.seeking).toBe(false);
      expect(el.currentTime).toBe(0);
      expect(el.readyState).toBe(0);
      expect(el.currentSrc).toBe('');
      expect(el.error).toBeNull();
      expect(() => el.load()).not.toThrow();
    });

    it('derives stream-type and live properties from src', () => {
      const el = createConnectedElement();

      expect(el.streamType).toBe('unknown');
      expect(el.liveEdgeStart).toBeNaN();
      expect(el.targetLiveWindow).toBeNaN();

      el.src = 'moqt://relay.example.com/live#msf:live--catalog';

      expect(el.streamType).toBe('live');
      expect(el.liveEdgeStart).toBe(0);
      expect(el.targetLiveWindow).toBe(0);
      expect(el.duration).toBe(Number.POSITIVE_INFINITY);
    });

    it('applies the muted attribute to muted and defaultMuted', () => {
      const el = createConnectedElement();

      el.setAttribute('muted', '');

      expect(el.muted).toBe(true);
      expect(el.defaultMuted).toBe(true);
    });
  });
});
