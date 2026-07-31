import { CameraRadioGroupElement } from '../../ui/camera-radio-group/camera-radio-group-element';
import { safeDefine } from '../safe-define';

safeDefine(CameraRadioGroupElement);

declare global {
  interface HTMLElementTagNameMap {
    [CameraRadioGroupElement.tagName]: CameraRadioGroupElement;
  }
}
