import { safeDefine } from '../../registration/safe-define';
import { MicButtonElement } from '../../ui/mic-button/mic-button-element';

safeDefine(MicButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [MicButtonElement.tagName]: MicButtonElement;
  }
}
