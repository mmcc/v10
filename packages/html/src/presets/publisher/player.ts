import { publisherFeatures } from '@videojs/core/dom';

import { createPlayer } from '../../player/create-player';

const { PlayerElement, PlayerController: VideoPublisherController } = createPlayer({
  features: publisherFeatures,
});

/** Player controller bound to the video publisher store. */
export const PlayerController = VideoPublisherController;

export class VideoPublisherElement extends PlayerElement {
  static readonly tagName = 'video-publisher';
}

declare global {
  interface HTMLElementTagNameMap {
    [VideoPublisherElement.tagName]: VideoPublisherElement;
  }
}
