import { safeDefine } from '../../registration/safe-define';
import { ScreenShareButtonElement } from '../../ui/screen-share-button/screen-share-button-element';

safeDefine(ScreenShareButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [ScreenShareButtonElement.tagName]: ScreenShareButtonElement;
  }
}
