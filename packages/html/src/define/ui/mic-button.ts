import { MicButtonElement } from '../../ui/mic-button/mic-button-element';
import { safeDefine } from '../safe-define';

safeDefine(MicButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [MicButtonElement.tagName]: MicButtonElement;
  }
}
