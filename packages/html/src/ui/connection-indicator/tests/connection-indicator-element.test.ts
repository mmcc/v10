import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaPublishStatsState } from '@videojs/media';
import { createStore, flush } from '@videojs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { playerContext } from '../../../player/context';
import { MediaElement } from '../../media-element';
import { ConnectionIndicatorElement } from '../connection-indicator-element';

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

interface PublishStatsStoreHandle {
  store: AnyPlayerStore;
  setState: (partial: Partial<MediaPublishStatsState>) => void;
}

function createPublishStatsStore(initial: Partial<MediaPublishStatsState> = {}): PublishStatsStoreHandle {
  let set: (partial: Partial<MediaPublishStatsState>) => void = () => {};

  const store = createStore<unknown>()<MediaPublishStatsState>({
    name: 'publishStats',
    state: () => ({
      publishStats: null,
      connectionQuality: 'unknown',
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
      flush();
    },
  };
}

class TestPlayerProviderElement extends MediaElement {
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

defineElement('test-connection-indicator-player', TestPlayerProviderElement);

function setup(initial: Partial<MediaPublishStatsState> = {}) {
  const handle = createPublishStatsStore(initial);
  const provider = document.createElement('test-connection-indicator-player') as TestPlayerProviderElement;
  const indicator = createElement(ConnectionIndicatorElement);

  provider.setStore(handle.store);
  provider.append(indicator);
  document.body.append(provider);

  return { ...handle, provider, indicator };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ConnectionIndicatorElement', () => {
  it('exposes the quality as the accessible label', async () => {
    const { indicator } = setup({ connectionQuality: 'poor' });

    await indicator.updateComplete;

    expect(indicator.getAttribute('role')).toBe('img');
    expect(indicator.getAttribute('aria-label')).toBe('Connection quality: poor');
    expect(indicator.getAttribute('data-quality')).toBe('poor');
  });

  it('re-labels when the quality changes', async () => {
    const { indicator, setState } = setup();

    await indicator.updateComplete;
    expect(indicator.getAttribute('aria-label')).toBe('Connection quality: unknown');

    setState({ connectionQuality: 'good' });
    await indicator.updateComplete;

    expect(indicator.getAttribute('aria-label')).toBe('Connection quality: good');
    expect(indicator.getAttribute('data-quality')).toBe('good');
  });
});
