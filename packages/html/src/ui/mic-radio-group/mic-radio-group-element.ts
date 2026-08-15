import { MicRadioGroupCore, MicRadioGroupDataAttrs, type MicRadioGroupDevice } from '@videojs/core';
import { applyStateDataAttrs, logMissingFeature, selectCaptureDevices } from '@videojs/core/dom';
import { type Text, translateText } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';
import { i18nContext } from '../../i18n/context';
import { I18nController } from '../../i18n/controller';
import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MenuRadioGroupElement } from '../menu/menu-radio-group-element';
import { RadioOptionsController } from '../radio-options/radio-options-controller';

export class MicRadioGroupElement extends MenuRadioGroupElement {
  static override readonly tagName = 'media-mic-radio-group';

  static override properties = {
    ...MenuRadioGroupElement.properties,
    disabled: { type: Boolean },
    label: { type: String },
  } satisfies PropertyDeclarationMap<'value' | 'label' | 'disabled'>;

  disabled = false;
  label: Text | string = '';
  formatDevice = MicRadioGroupCore.defaultProps.formatDevice;

  readonly #core = new MicRadioGroupCore();
  readonly #i18n = new I18nController(this, i18nContext);
  readonly #mediaState = new PlayerController(this, playerContext, selectCaptureDevices);
  readonly #options = new RadioOptionsController<MicRadioGroupDevice & { disabled: boolean }>(this, {
    setItemAttributes: (item, option) => item.setAttribute('data-device', option.value),
    onValueChange: (value) => {
      const media = this.#mediaState.value;
      if (media) this.#core.selectValue(media, value);
    },
  });

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    if (__DEV__ && !this.#mediaState.value && this.#mediaState.displayName) {
      logMissingFeature(this.localName, this.#mediaState.displayName);
    }
  }

  protected override update(changed: PropertyValues): void {
    const media = this.#mediaState.value;
    let state: MicRadioGroupCore.State | null = null;

    if (media) {
      this.#core.setProps({ formatDevice: this.formatDevice, disabled: this.disabled, label: this.label });
      this.#core.setMedia(media);
      state = this.#core.getState();

      this.applyDefaultAriaLabel(translateText(this.#core.getLabel(state), this.#i18n.value));
      this.#options.sync(
        {
          ...state,
          // Availability drives visibility via data attributes, not `hidden`.
          hidden: false,
          options: state.devices.map((device) => ({ ...device, disabled: false })),
        },
        this.#i18n.value,
        this.#i18n.locale
      );
      this.publishMenuMetadata(state.disabled, state.availability);
    }

    super.update(changed);

    if (state) applyStateDataAttrs(this, state, MicRadioGroupDataAttrs);
  }
}

export namespace MicRadioGroupElement {
  export type State = MicRadioGroupCore.State;
}
