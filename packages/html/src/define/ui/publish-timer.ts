import { safeDefine } from '../../registration/safe-define';
import { PublishTimerElement } from '../../ui/publish-timer/element';

safeDefine(PublishTimerElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishTimerElement.tagName]: PublishTimerElement;
  }
}
