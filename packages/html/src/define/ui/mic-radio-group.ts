import { safeDefine } from '../../registration/safe-define';
import { MicRadioGroupElement } from '../../ui/mic-radio-group/mic-radio-group-element';

safeDefine(MicRadioGroupElement);

declare global {
  interface HTMLElementTagNameMap {
    [MicRadioGroupElement.tagName]: MicRadioGroupElement;
  }
}
