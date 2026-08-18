import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaCaptureSourceState, MediaPublishState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { playerContext } from '../../../player/context';
import { MediaElement } from '../../media-element';
import { PublishButtonElement } from '../publish-button-element';

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

/** One slice carrying both feature states the publish button composes. */
type PublisherSliceState = MediaPublishState & MediaCaptureSourceState;

function createPublisherStore({
  publishState = 'idle',
  cameraState = 'active',
  micState = 'idle',
  micExplicit = false,
  publish = vi.fn(() => Promise.resolve()),
  unpublish = vi.fn(),
}: {
  publishState?: MediaPublishState['publishState'] | undefined;
  cameraState?: MediaCaptureSourceState['cameraState'] | undefined;
  micState?: MediaCaptureSourceState['micState'] | undefined;
  micExplicit?: MediaCaptureSourceState['micExplicit'] | undefined;
  publish?: MediaPublishState['publish'] | undefined;
  unpublish?: MediaPublishState['unpublish'] | undefined;
} = {}): AnyPlayerStore {
  return createStore<unknown>()<PublisherSliceState>({
    name: 'publisher',
    state: () => ({
      publishState,
      publishStartedAt: Number.NaN,
      publishError: null,
      publish,
      unpublish,
      cameraActive: cameraState === 'active',
      screenShareActive: false,
      micActive: micExplicit,
      micExplicit,
      cameraState,
      screenShareState: 'idle',
      micState,
      screenShareAvailability: 'unavailable',
      toggleCamera: vi.fn(() => false),
      toggleScreenShare: vi.fn(() => false),
      toggleMic: vi.fn(() => false),
    }),
  }) as unknown as AnyPlayerStore;
}

class TestPlayerProviderElement extends MediaElement {
  store: AnyPlayerStore = createPublisherStore();

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

defineElement('test-publish-button-player', TestPlayerProviderElement);

function setup(storeOptions: Parameters<typeof createPublisherStore>[0] = {}) {
  const provider = document.createElement('test-publish-button-player') as TestPlayerProviderElement;
  const button = createElement(PublishButtonElement);

  provider.setStore(createPublisherStore(storeOptions));
  provider.append(button);
  document.body.append(provider);

  return { provider, button };
}

function click(button: HTMLElement): void {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('PublishButtonElement', () => {
  it('renders the default label and reflects an idle session', async () => {
    const { button } = setup();

    await button.updateComplete;

    expect(button.textContent).toBe('Go live');
    expect(button.getAttribute('aria-label')).toBe('Go live');
    expect(button.getAttribute('role')).toBe('button');
    expect(button.getAttribute('data-publish-state')).toBe('idle');
    expect(button.hasAttribute('data-disabled')).toBe(false);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('starts a publish session on click while idle with active capture', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const { button } = setup({ publish });

    await button.updateComplete;
    click(button);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stops the session on click while live', async () => {
    const unpublish = vi.fn();
    const { button } = setup({ publishState: 'live', unpublish });

    await button.updateComplete;

    expect(button.textContent).toBe('Stop stream');
    expect(button.getAttribute('data-publish-state')).toBe('live');

    click(button);

    expect(unpublish).toHaveBeenCalledTimes(1);
  });

  it('is disabled while capture is inactive', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const { button } = setup({ cameraState: 'idle', publish });

    await button.updateComplete;

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('data-disabled')).toBe(true);

    click(button);

    expect(publish).not.toHaveBeenCalled();
  });

  it('enables and starts a session from a mic-only capture', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const { button } = setup({ cameraState: 'idle', micState: 'active', micExplicit: true, publish });

    await button.updateComplete;

    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('data-disabled')).toBe(false);

    click(button);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stays disabled on an implied mic without explicit intent', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const { button } = setup({ cameraState: 'idle', micState: 'active', micExplicit: false, publish });

    await button.updateComplete;

    expect(button.getAttribute('aria-disabled')).toBe('true');

    click(button);

    expect(publish).not.toHaveBeenCalled();
  });
});
