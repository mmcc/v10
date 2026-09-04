import { ConnectionIndicatorCore, ConnectionIndicatorDataAttrs } from '@videojs/core';
import { selectPublishStats } from '@videojs/core/dom';
import type { Text } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaUIElement } from '../media-ui-element';

/**
 * `<media-connection-indicator>` — coarse connection health for the active publish session. Content (typically an icon)
 * is authored by the skin; the element reflects `data-quality` for styling.
 */
export class ConnectionIndicatorElement extends MediaUIElement<ConnectionIndicatorCore> {
  static readonly tagName = 'media-connection-indicator';

  static override properties: PropertyDeclarationMap = {
    label: { type: String },
  };

  label: Text | string = '';

  protected readonly core = new ConnectionIndicatorCore();
  protected readonly stateAttrMap = ConnectionIndicatorDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectPublishStats);

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    this.core.setProps(this);
  }
}
