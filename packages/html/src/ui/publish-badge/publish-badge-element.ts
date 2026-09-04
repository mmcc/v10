import { PublishBadgeCore, PublishBadgeDataAttrs } from '@videojs/core';
import { selectPublish } from '@videojs/core/dom';
import { type Text, translateText } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';

import { i18nContext } from '../../i18n/context';
import { I18nController } from '../../i18n/controller';
import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaUIElement } from '../media-ui-element';

/**
 * `<media-publish-badge>` — publish session status badge. Renders the core's translated label ("Live" / "Connecting…" /
 * "Offline") as default content when no custom content is authored, and reflects the session lifecycle on
 * `data-publish-state` for styling.
 */
export class PublishBadgeElement extends MediaUIElement<PublishBadgeCore> {
  static readonly tagName = 'media-publish-badge';

  static override properties: PropertyDeclarationMap = {
    label: { type: String },
  };

  label: Text | string = '';

  protected readonly core = new PublishBadgeCore();
  protected readonly stateAttrMap = PublishBadgeDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectPublish);
  readonly #i18n = new I18nController(this, i18nContext);

  #defaultContent = false;

  override connectedCallback(): void {
    super.connectedCallback();

    if (this.destroyed) return;

    this.#defaultContent ||= !this.textContent?.trim();
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
    }
  }
}
