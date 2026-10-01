import { safeDefine } from '../../registration/safe-define';
import { EnableDevicesButtonElement } from '../../ui/enable-devices-button/element';

safeDefine(EnableDevicesButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [EnableDevicesButtonElement.tagName]: EnableDevicesButtonElement;
  }
}
