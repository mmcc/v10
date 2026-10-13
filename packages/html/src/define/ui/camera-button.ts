import { safeDefine } from '../../registration/safe-define';
import { CameraButtonElement } from '../../ui/camera-button/element';

safeDefine(CameraButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [CameraButtonElement.tagName]: CameraButtonElement;
  }
}
