import { safeDefine } from '../../registration/safe-define';
import { PublishBadgeElement } from '../../ui/publish-badge/publish-badge-element';

safeDefine(PublishBadgeElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishBadgeElement.tagName]: PublishBadgeElement;
  }
}
