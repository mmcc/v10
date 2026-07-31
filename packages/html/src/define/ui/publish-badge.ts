import { PublishBadgeElement } from '../../ui/publish-badge/publish-badge-element';
import { safeDefine } from '../safe-define';

safeDefine(PublishBadgeElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishBadgeElement.tagName]: PublishBadgeElement;
  }
}
