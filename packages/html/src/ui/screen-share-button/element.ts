import { ScreenShareButtonCore, ScreenShareButtonDataAttrs, type ScreenShareButtonState } from '@videojs/core';
import { selectCaptureSource } from '@videojs/core/dom';
import type { MediaCaptureSourceState } from '@videojs/media';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/controller';
import { MediaButtonElement } from '../media-button-element';

export class ScreenShareButtonElement extends MediaButtonElement<ScreenShareButtonState, MediaCaptureSourceState> {
  static readonly tagName = 'media-screen-share-button';

  protected readonly core = new ScreenShareButtonCore();
  protected readonly stateAttrMap = ScreenShareButtonDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectCaptureSource);

  protected activate(state: MediaCaptureSourceState): void {
    this.core.toggle(state);
  }
}
