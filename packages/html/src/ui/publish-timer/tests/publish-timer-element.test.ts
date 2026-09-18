import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaPublishState } from '@videojs/media';
import { createStore, flush } from '@videojs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { playerContext } from '../../../player/context';
import { UIElement } from '../../ui-element';
import { PublishTimerElement } from '../publish-timer-element';

let tagCounter = 0;

function uniqueTag(base: string): string {
  return `${base}-${tagCounter++}`;
}

function createElement<Element extends HTMLElement>(Base: abstract new () => Element): Element {
  const tag = uniqueTag('test-el');

  customElements.define(tag, class extends (Base as unknown as typeof HTMLElement) {});
  return document.createElement(tag) as Element;
}

function defineElement(tagName: string, Base: CustomElementConstructor): void {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, Base);
  }
}

interface PublishStoreHandle {
  store: AnyPlayerStore;
  setState: (partial: Partial<MediaPublishState>) => void;
}

function createPublishStore(initial: Partial<MediaPublishState> = {}): PublishStoreHandle {
  let set: (partial: Partial<MediaPublishState>) => void = () => {};

  const store = createStore<unknown>()<MediaPublishState>({
    name: 'publish',
    state: () => ({
      publishState: 'idle',
      publishStartedAt: Number.NaN,
      publishError: null,
      publish: vi.fn(() => Promise.resolve()),
      unpublish: vi.fn(),
      ...initial,
    }),
    attach: (context) => {
      set = context.set;
    },
  });

  store.attach({});

  return {
    store: store as unknown as AnyPlayerStore,
    setState: (partial) => {
      set(partial);
      // Store notifications are microtask-batched; flush so element updates
      // are observable through `updateComplete` under fake timers.
      flush();
    },
  };
}

class TestPlayerProviderElement extends UIElement {
  store: AnyPlayerStore | null = null;

  readonly #provider = new ContextProvider(this, { context: playerContext });

  override connectedCallback(): void {
    if (this.store) this.#provider.setValue(this.store);

    super.connectedCallback();
  }

  setStore(store: AnyPlayerStore): void {
    this.store = store;
    this.#provider.setValue(store);
  }
}

defineElement('test-publish-timer-player', TestPlayerProviderElement);

function setup(initial: Partial<MediaPublishState> = {}) {
  const handle = createPublishStore(initial);
  const provider = document.createElement('test-publish-timer-player') as TestPlayerProviderElement;
  const timer = createElement(PublishTimerElement);

  provider.setStore(handle.store);
  provider.append(timer);
  document.body.append(provider);

  return { ...handle, provider, timer };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PublishTimerElement', () => {
  it('renders 0:00 while idle and applies the default label', async () => {
    const { timer } = setup();

    await timer.updateComplete;

    expect(timer.textContent).toBe('0:00');
    expect(timer.getAttribute('aria-label')).toBe('Stream duration');
    expect(timer.getAttribute('data-publish-state')).toBe('idle');
  });

  it('renders elapsed time and ticks once per second while live', async () => {
    const { timer, setState } = setup();

    await timer.updateComplete;

    setState({ publishState: 'live', publishStartedAt: Date.now() - 65_000 });
    await timer.updateComplete;

    expect(timer.textContent).toBe('1:05');
    expect(timer.getAttribute('data-publish-state')).toBe('live');

    vi.advanceTimersByTime(1000);
    await timer.updateComplete;
    expect(timer.textContent).toBe('1:06');

    vi.advanceTimersByTime(2000);
    await timer.updateComplete;
    expect(timer.textContent).toBe('1:08');
  });

  it('starts the interval on live and stops it when the session ends', async () => {
    const { timer, setState } = setup();

    await timer.updateComplete;
    const idleTimerCount = vi.getTimerCount();

    setState({ publishState: 'live', publishStartedAt: Date.now() });
    await timer.updateComplete;
    expect(vi.getTimerCount()).toBe(idleTimerCount + 1);

    setState({ publishState: 'idle', publishStartedAt: Number.NaN });
    await timer.updateComplete;
    expect(vi.getTimerCount()).toBe(idleTimerCount);
    expect(timer.textContent).toBe('0:00');
  });

  it('stops the interval on disconnect while live', async () => {
    const { timer, setState } = setup();

    await timer.updateComplete;
    const idleTimerCount = vi.getTimerCount();

    setState({ publishState: 'live', publishStartedAt: Date.now() });
    await timer.updateComplete;
    expect(vi.getTimerCount()).toBe(idleTimerCount + 1);

    timer.remove();
    // Disconnect also schedules DestroyMixin's deferred-destroy animation
    // frames; a leaked interval would keep rescheduling and abort this drain.
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});
