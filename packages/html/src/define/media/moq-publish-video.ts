import { MoqPublishVideo } from '../../media/moq-publish-video';
import { safeDefine } from '../../registration/safe-define';

export class MoqPublishVideoElement extends MoqPublishVideo {
  static readonly tagName = 'moq-publish-video';
}

safeDefine(MoqPublishVideoElement);

declare global {
  interface HTMLElementTagNameMap {
    [MoqPublishVideoElement.tagName]: MoqPublishVideoElement;
  }
}
