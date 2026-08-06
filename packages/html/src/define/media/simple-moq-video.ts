import { SimpleMoqVideo } from '../../media/simple-moq-video';
import { safeDefine } from '../safe-define';

export class SimpleMoqVideoElement extends SimpleMoqVideo {
  static readonly tagName = 'simple-moq-video';
}

safeDefine(SimpleMoqVideoElement);

declare global {
  interface HTMLElementTagNameMap {
    [SimpleMoqVideoElement.tagName]: SimpleMoqVideoElement;
  }
}
