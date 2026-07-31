import { publisherFeatures } from '@videojs/core/dom';
import { MediaContainerElement } from '../../media/container-element';
import { createPlayer } from '../../player/create-player';
import { MediaElement } from '../../ui/media-element';
import { safeDefine } from '../safe-define';

const { ProviderMixin } = createPlayer({
  features: publisherFeatures,
});

export class VideoPublisherElement extends ProviderMixin(MediaElement) {
  static readonly tagName = 'video-publisher';
}

// Provider must be defined before consumer for context handshake during upgrade.
safeDefine(VideoPublisherElement);
safeDefine(MediaContainerElement);

declare global {
  interface HTMLElementTagNameMap {
    [VideoPublisherElement.tagName]: VideoPublisherElement;
  }
}
