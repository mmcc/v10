import { safeDefine } from '../../registration/safe-define';
import { PublishButtonElement } from '../../ui/publish-button/publish-button-element';

safeDefine(PublishButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishButtonElement.tagName]: PublishButtonElement;
  }
}
