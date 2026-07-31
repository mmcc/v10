import { CameraRadioGroupCore, CameraRadioGroupDataAttrs } from '@videojs/core';
import { applyStateDataAttrs, logMissingFeature, selectCaptureDevices } from '@videojs/core/dom';
import { type Text, type Translator, translateText } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';
import { cacheKey } from '../../i18n/cache-key';
import { i18nContext } from '../../i18n/context';
import { I18nController } from '../../i18n/controller';
import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MenuItemIndicatorElement } from '../menu/menu-item-indicator-element';
import { MenuRadioGroupElement } from '../menu/menu-radio-group-element';
import { MenuRadioItemElement } from '../menu/menu-radio-item-element';

export class CameraRadioGroupElement extends MenuRadioGroupElement {
  static override readonly tagName = 'media-camera-radio-group';

  static override properties = {
    ...MenuRadioGroupElement.properties,
    disabled: { type: Boolean },
    label: { type: String },
  } satisfies PropertyDeclarationMap<'value' | 'label' | 'disabled'>;

  disabled = false;
  label: Text | string = '';
  formatDevice = CameraRadioGroupCore.defaultProps.formatDevice;

  readonly #core = new CameraRadioGroupCore();
  readonly #i18n = new I18nController(this, i18nContext);
  readonly #mediaState = new PlayerController(this, playerContext, selectCaptureDevices);

  #devicesKey = '';
  #devicesTranslator: Translator | null = null;
  #disconnect: AbortController | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    this.#disconnect = new AbortController();
    this.addEventListener('value-change', this.#handleValueChange, { signal: this.#disconnect.signal });

    if (__DEV__ && !this.#mediaState.value && this.#mediaState.displayName) {
      logMissingFeature(this.localName, this.#mediaState.displayName);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#disconnect?.abort();
    this.#disconnect = null;
  }

  protected override update(changed: PropertyValues): void {
    const media = this.#mediaState.value;
    let state: CameraRadioGroupCore.State | null = null;

    if (media) {
      this.#core.setProps({ formatDevice: this.formatDevice, disabled: this.disabled, label: this.label });
      this.#core.setMedia(media);
      state = this.#core.getState();

      this.value = state.value;
      this.applyAriaLabel(this.#i18n.value, this.#core.getLabel(state));
      if (state.disabled) {
        this.setAttribute('aria-disabled', 'true');
      } else {
        this.removeAttribute('aria-disabled');
      }
      this.#syncContent(state);
    }

    super.update(changed);

    if (state) applyStateDataAttrs(this, state, CameraRadioGroupDataAttrs);
  }

  #syncContent(state: CameraRadioGroupCore.State): void {
    const template = this.getTemplate();
    const templateKey = template?.innerHTML ?? '';
    const translator = this.#i18n.value;
    const devicesKey = `${state.devices.map((device) => `${device.value}:${cacheKey(device.label)}`).join('|')}::${this.#i18n.locale}::${templateKey}`;

    if (devicesKey !== this.#devicesKey || translator !== this.#devicesTranslator) {
      this.#devicesKey = devicesKey;
      this.#devicesTranslator = translator;

      for (const child of [...this.children]) {
        if (child instanceof HTMLTemplateElement) continue;
        child.remove();
      }

      this.append(
        ...state.devices.map((device) =>
          this.#createItem(device.value, translateText(device.label, translator), template)
        )
      );
    }

    for (const item of this.querySelectorAll<MenuRadioItemElement>(MenuRadioItemElement.tagName)) {
      const checked = item.value === this.value;

      item.disabled = state.disabled;

      for (const indicator of item.querySelectorAll<MenuItemIndicatorElement>(MenuItemIndicatorElement.tagName)) {
        indicator.checked = checked;
      }
    }
  }

  #createItem(value: string, label: string, template: HTMLTemplateElement | null): MenuRadioItemElement {
    const item = this.createRadioItem(template);

    item.value = value;
    item.setAttribute('data-device', value);
    this.setItemLabel(item, label);

    return item;
  }

  #handleValueChange = (event: Event): void => {
    if (event.target !== this) return;

    const media = this.#mediaState.value;
    if (!media) return;

    const { value } = (event as CustomEvent<{ value: string }>).detail;
    this.#core.selectValue(media, value);
  };
}

export namespace CameraRadioGroupElement {
  export type State = CameraRadioGroupCore.State;
}
