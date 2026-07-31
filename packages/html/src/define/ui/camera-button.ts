import { CameraButtonElement } from '../../ui/camera-button/camera-button-element';
import { safeDefine } from '../safe-define';

safeDefine(CameraButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [CameraButtonElement.tagName]: CameraButtonElement;
  }
}
