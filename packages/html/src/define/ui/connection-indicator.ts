import { safeDefine } from '../../registration/safe-define';
import { ConnectionIndicatorElement } from '../../ui/connection-indicator/connection-indicator-element';

safeDefine(ConnectionIndicatorElement);

declare global {
  interface HTMLElementTagNameMap {
    [ConnectionIndicatorElement.tagName]: ConnectionIndicatorElement;
  }
}
