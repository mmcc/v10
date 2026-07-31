import { ConnectionIndicatorElement } from '../../ui/connection-indicator/connection-indicator-element';
import { safeDefine } from '../safe-define';

safeDefine(ConnectionIndicatorElement);

declare global {
  interface HTMLElementTagNameMap {
    [ConnectionIndicatorElement.tagName]: ConnectionIndicatorElement;
  }
}
