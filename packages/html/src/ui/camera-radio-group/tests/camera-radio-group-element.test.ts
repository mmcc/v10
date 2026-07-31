import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import type { MediaCaptureDevicesState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { playerContext } from '../../../player/context';
import { MediaElement } from '../../media-element';
import { MenuElement } from '../../menu/menu-element';
import { MenuItemIndicatorElement } from '../../menu/menu-item-indicator-element';
import { MenuRadioGroupElement } from '../../menu/menu-radio-group-element';
import { MenuRadioItemElement } from '../../menu/menu-radio-item-element';
import { CameraRadioGroupElement } from '../camera-radio-group-element';

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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let error: unknown;

  for (let index = 0; index < 10; index++) {
    try {
      assertion();
      return;
    } catch (caught) {
      error = caught;
      await nextFrame();
    }
  }

  throw error;
}

function createCaptureDevicesStore({
  cameras = [
    { deviceId: 'cam-1', kind: 'videoinput', label: 'Front Camera' },
    { deviceId: 'cam-2', kind: 'videoinput', label: 'Back Camera' },
  ],
  selectedCameraId = 'cam-1',
  selectCamera = vi.fn(),
}: {
  cameras?: MediaCaptureDevicesState['cameras'] | undefined;
  selectedCameraId?: string | undefined;
  selectCamera?: MediaCaptureDevicesState['selectCamera'] | undefined;
} = {}): AnyPlayerStore {
  return createStore<unknown>()<MediaCaptureDevicesState>({
    name: 'captureDevices',
    state: () => ({
      cameras,
      microphones: [],
      selectedCameraId,
      selectedMicrophoneId: '',
      selectCamera,
      selectMicrophone: vi.fn(),
    }),
  }) as unknown as AnyPlayerStore;
}

class TestPlayerProviderElement extends MediaElement {
  store: AnyPlayerStore = createCaptureDevicesStore();

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

defineElement(MenuElement.tagName, MenuElement);
defineElement(MenuRadioGroupElement.tagName, MenuRadioGroupElement);
defineElement(MenuRadioItemElement.tagName, MenuRadioItemElement);
defineElement(MenuItemIndicatorElement.tagName, MenuItemIndicatorElement);
defineElement(CameraRadioGroupElement.tagName, CameraRadioGroupElement);
defineElement('test-camera-radio-player', TestPlayerProviderElement);

function setup(storeOptions: Parameters<typeof createCaptureDevicesStore>[0] = {}) {
  const provider = document.createElement('test-camera-radio-player') as TestPlayerProviderElement;
  const menu = createElement(MenuElement);
  const options = createElement(CameraRadioGroupElement);

  provider.setStore(createCaptureDevicesStore(storeOptions));

  menu.append(options);
  provider.append(menu);
  document.body.append(provider);

  return { menu, options };
}

async function waitForMenu(menu: MenuElement, options: CameraRadioGroupElement): Promise<void> {
  await menu.updateComplete;
  await options.updateComplete;

  const items = [...menu.querySelectorAll<MenuRadioItemElement>(MenuRadioItemElement.tagName)];
  await Promise.all(items.map((item) => item.updateComplete));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('CameraRadioGroupElement', () => {
  it('renders camera radio items with the selected device checked', async () => {
    const { menu, options } = setup();

    await waitForMenu(menu, options);

    const items = [...menu.querySelectorAll<MenuRadioItemElement>(MenuRadioItemElement.tagName)];

    expect(items.map((item) => item.textContent)).toEqual(['Front Camera', 'Back Camera']);
    expect(items.map((item) => item.getAttribute('data-device'))).toEqual(['cam-1', 'cam-2']);
    await waitForAssertion(() => {
      expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    });
    expect(options.getAttribute('data-camera')).toBe('cam-1');
    expect(options.getAttribute('data-availability')).toBe('available');
  });

  it('falls back to numbered labels until device permission reveals them', async () => {
    const { menu, options } = setup({
      cameras: [
        { deviceId: 'cam-1', kind: 'videoinput', label: '' },
        { deviceId: 'cam-2', kind: 'videoinput', label: '' },
      ],
    });

    await waitForMenu(menu, options);

    const items = [...menu.querySelectorAll<MenuRadioItemElement>(MenuRadioItemElement.tagName)];
    expect(items.map((item) => item.textContent)).toEqual(['Camera 1', 'Camera 2']);
  });

  it('is unavailable and disabled with a single camera', async () => {
    const { menu, options } = setup({
      cameras: [{ deviceId: 'cam-1', kind: 'videoinput', label: 'Front Camera' }],
    });

    await waitForMenu(menu, options);

    expect(options.getAttribute('data-availability')).toBe('unavailable');
    expect(options.hasAttribute('data-disabled')).toBe(true);
    expect(options.getAttribute('aria-disabled')).toBe('true');
  });

  it('selects a camera on item activation', async () => {
    const selectCamera = vi.fn();
    const { menu, options } = setup({ selectCamera });

    await waitForMenu(menu, options);

    const item = [...menu.querySelectorAll<MenuRadioItemElement>(MenuRadioItemElement.tagName)].find(
      (candidate) => candidate.value === 'cam-2'
    )!;

    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(selectCamera).toHaveBeenCalledWith('cam-2');
  });
});
