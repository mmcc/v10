import { safeDefine } from '../../registration/safe-define';
import { CameraRadioGroupElement } from '../../ui/camera-radio-group/camera-radio-group-element';

safeDefine(CameraRadioGroupElement);

declare global {
  interface HTMLElementTagNameMap {
    [CameraRadioGroupElement.tagName]: CameraRadioGroupElement;
  }
}
