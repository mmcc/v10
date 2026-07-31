import { PublishTimerElement } from '../../ui/publish-timer/publish-timer-element';
import { safeDefine } from '../safe-define';

safeDefine(PublishTimerElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublishTimerElement.tagName]: PublishTimerElement;
  }
}
