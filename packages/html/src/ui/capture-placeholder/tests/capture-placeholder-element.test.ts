import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaCaptureSourceState } from '@videojs/media';
import { createStore, flush } from '@videojs/store';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { playerContext } from '../../../player/context';
import { UIElement } from '../../ui-element';
import { CapturePlaceholderElement } from '../capture-placeholder-element';

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

interface CaptureSourceStoreHandle {
  store: AnyPlayerStore;
  setState: (partial: Partial<MediaCaptureSourceState>) => void;
}

function createCaptureSourceStore(initial: Partial<MediaCaptureSourceState> = {}): CaptureSourceStoreHandle {
  let set: (partial: Partial<MediaCaptureSourceState>) => void = () => {};

  const store = createStore<unknown>()<MediaCaptureSourceState>({
    name: 'captureSource',
    state: () => ({
      cameraActive: false,
      screenShareActive: false,
      micActive: false,
      micExplicit: false,
      cameraState: 'idle',
      screenShareState: 'idle',
      micState: 'idle',
      screenShareAvailability: 'available',
      toggleCamera: vi.fn(() => true),
      toggleScreenShare: vi.fn(() => true),
      toggleMic: vi.fn(() => true),
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

defineElement('test-capture-placeholder-player', TestPlayerProviderElement);

function setup(initial: Partial<MediaCaptureSourceState> = {}, children?: Element) {
  const handle = createCaptureSourceStore(initial);
  const provider = document.createElement('test-capture-placeholder-player') as TestPlayerProviderElement;
  const placeholder = createElement(CapturePlaceholderElement);

  if (children) placeholder.append(children);

  provider.setStore(handle.store);
  provider.append(placeholder);
  document.body.append(provider);

  return { ...handle, provider, placeholder };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('CapturePlaceholderElement', () => {
  it('renders the guidance text and aria-label without authored content', async () => {
    const { placeholder } = setup();

    await placeholder.updateComplete;

    expect(placeholder.textContent).toBe('Enable camera and microphone');
    expect(placeholder.getAttribute('aria-label')).toBe('Enable camera and microphone');
    expect(placeholder.getAttribute('data-capture-state')).toBe('idle');
  });

  it('does not apply an aria-label when authored content exists', async () => {
    const content = document.createElement('div');

    content.textContent = 'Custom content';
    const { placeholder, setState } = setup({}, content);

    await placeholder.updateComplete;

    expect(placeholder.textContent).toBe('Custom content');
    expect(placeholder.hasAttribute('aria-label')).toBe(false);

    // Stays suppressed across state-driven updates.
    setState({ cameraState: 'denied' });
    await placeholder.updateComplete;

    expect(placeholder.hasAttribute('aria-label')).toBe(false);
    expect(placeholder.getAttribute('data-capture-state')).toBe('denied');
  });

  it('reports a mic-only capture as active and clears the guidance', async () => {
    const { placeholder, setState } = setup();

    await placeholder.updateComplete;

    setState({ micState: 'active', micActive: true, micExplicit: true });
    await placeholder.updateComplete;

    expect(placeholder.getAttribute('data-capture-state')).toBe('active');
    expect(placeholder.textContent).toBe('');

    // An implied mic (video intent gone, mic lingering) must not keep the
    // placeholder cleared on its own.
    setState({ micActive: false, micExplicit: false });
    await placeholder.updateComplete;

    expect(placeholder.getAttribute('data-capture-state')).toBe('idle');
    expect(placeholder.textContent).toBe('Enable camera and microphone');
  });

  it('keeps permission guidance after a mic-only denial consumes the intent', async () => {
    const { placeholder, setState } = setup();

    await placeholder.updateComplete;

    setState({ micState: 'denied', micActive: false, micExplicit: true });
    await placeholder.updateComplete;

    expect(placeholder.getAttribute('data-capture-state')).toBe('denied');
    expect(placeholder.textContent).toBe(
      'Camera and microphone access is blocked. Update your browser permissions to continue.'
    );
  });
});
