import { SimpleMoqVideo } from '../../media/simple-moq-video';
import { safeDefine } from '../../registration/safe-define';

/** SPF-backed MoQ media element registered as `<simple-moq-video>`. */
export class SimpleMoqVideoElement extends SimpleMoqVideo {
  static readonly tagName = 'simple-moq-video';
}

safeDefine(SimpleMoqVideoElement);

declare global {
  interface HTMLElementTagNameMap {
    [SimpleMoqVideoElement.tagName]: SimpleMoqVideoElement;
  }
}
