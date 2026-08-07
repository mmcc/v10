import { ScreenShareButtonElement } from '../../ui/screen-share-button/screen-share-button-element';
import { safeDefine } from '../safe-define';

safeDefine(ScreenShareButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [ScreenShareButtonElement.tagName]: ScreenShareButtonElement;
  }
}
