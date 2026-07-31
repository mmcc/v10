import { CapturePlaceholderCore, CapturePlaceholderDataAttrs } from '@videojs/core';
import { selectCaptureSource } from '@videojs/core/dom';
import { type Text, translateText } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';

import { i18nContext } from '../../i18n/context';
import { I18nController } from '../../i18n/controller';
import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaUIElement } from '../media-ui-element';

/**
 * `<media-capture-placeholder>` — placeholder shown over the preview area
 * before capture is active. Authored children are kept as-is; without them
 * the element renders the core's translated guidance text. Visibility is a
 * styling concern: skins show/hide it via the reflected
 * `data-capture-state` attribute.
 */
export class CapturePlaceholderElement extends MediaUIElement<CapturePlaceholderCore> {
  static readonly tagName = 'media-capture-placeholder';

  static override properties: PropertyDeclarationMap = {
    label: { type: String },
  };

  label: Text | string = '';

  protected readonly core = new CapturePlaceholderCore();
  protected readonly stateAttrMap = CapturePlaceholderDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectCaptureSource);
  readonly #i18n = new I18nController(this, i18nContext);

  #defaultContent = false;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    // Custom content may be icon-only, so check elements as well as text.
    this.#defaultContent ||= this.childElementCount === 0 && !this.textContent?.trim();
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    this.core.setProps(this);
  }

  protected override update(changed: PropertyValues): void {
    // The base update refreshes core state from media and applies attrs.
    super.update(changed);

    if (this.#defaultContent) {
      this.textContent = translateText(this.core.getLabel(this.core.state.current), this.#i18n.value);
    } else {
      // Authored children carry the message themselves — an aria-label here
      // would announce the same guidance twice.
      this.removeAttribute('aria-label');
    }
  }
}
