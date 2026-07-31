import { EnableDevicesButtonElement } from '../../ui/enable-devices-button/enable-devices-button-element';
import { safeDefine } from '../safe-define';

safeDefine(EnableDevicesButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [EnableDevicesButtonElement.tagName]: EnableDevicesButtonElement;
  }
}
