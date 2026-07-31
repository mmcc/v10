import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaCaptureTracksState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { playerContext } from '../../../player/context';
import { MediaElement } from '../../media-element';
import { CameraButtonElement } from '../camera-button-element';

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

function createCaptureTracksStore({
  cameraMuted = false,
  toggleCameraMuted = vi.fn(() => true),
}: {
  cameraMuted?: boolean | undefined;
  toggleCameraMuted?: MediaCaptureTracksState['toggleCameraMuted'] | undefined;
} = {}): AnyPlayerStore {
  return createStore<unknown>()<MediaCaptureTracksState>({
    name: 'captureTracks',
    state: () => ({
      cameraMuted,
      micMuted: false,
      setCameraMuted: vi.fn(),
      toggleCameraMuted,
      setMicMuted: vi.fn(),
      toggleMicMuted: vi.fn(() => true),
    }),
  }) as unknown as AnyPlayerStore;
}

class TestPlayerProviderElement extends MediaElement {
  store: AnyPlayerStore = createCaptureTracksStore();

  readonly #provider = new ContextProvider(this, { context: playerContext });

  override connectedCallback(): void {
    this.#provider.setValue(this.store);
    super.connectedCallback();
  }

  setStore(store: AnyPlayerStore): void {
    this.store = store;
    this.#provider.setValue(store);
  }
}

defineElement('test-camera-button-player', TestPlayerProviderElement);

function setup(storeOptions: Parameters<typeof createCaptureTracksStore>[0] = {}) {
  const provider = document.createElement('test-camera-button-player') as TestPlayerProviderElement;
  const button = createElement(CameraButtonElement);

  provider.setStore(createCaptureTracksStore(storeOptions));
  provider.append(button);
  document.body.append(provider);

  return { provider, button };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('CameraButtonElement', () => {
  it('applies the mute label and no data-muted while the camera is on', async () => {
    const { button } = setup();

    await button.updateComplete;

    expect(button.getAttribute('aria-label')).toBe('Turn camera off');
    expect(button.getAttribute('role')).toBe('button');
    expect(button.hasAttribute('data-muted')).toBe(false);
  });

  it('applies the unmute label and data-muted while the camera is muted', async () => {
    const { button } = setup({ cameraMuted: true });

    await button.updateComplete;

    expect(button.getAttribute('aria-label')).toBe('Turn camera on');
    expect(button.hasAttribute('data-muted')).toBe(true);
  });

  it('toggles the camera on click', async () => {
    const toggleCameraMuted = vi.fn(() => true);
    const { button } = setup({ toggleCameraMuted });

    await button.updateComplete;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(toggleCameraMuted).toHaveBeenCalledTimes(1);
  });
});
