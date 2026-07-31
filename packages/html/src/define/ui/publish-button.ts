import { PublishButtonElement } from '../../ui/publish-button/publish-button-element';
import { safeDefine } from '../safe-define';

safeDefine(PublishButtonElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishButtonElement.tagName]: PublishButtonElement;
  }
}
