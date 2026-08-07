import { MicRadioGroupElement } from '../../ui/mic-radio-group/mic-radio-group-element';
import { safeDefine } from '../safe-define';

safeDefine(MicRadioGroupElement);

declare global {
  interface HTMLElementTagNameMap {
    [MicRadioGroupElement.tagName]: MicRadioGroupElement;
  }
}
