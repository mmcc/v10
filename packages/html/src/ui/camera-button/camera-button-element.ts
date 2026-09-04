import { CameraButtonCore, CameraButtonDataAttrs } from '@videojs/core';
import { selectCaptureTracks } from '@videojs/core/dom';
import type { MediaCaptureTracksState } from '@videojs/media';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaButtonElement } from '../media-button-element';

export class CameraButtonElement extends MediaButtonElement<CameraButtonCore> {
  static readonly tagName = 'media-camera-button';

  protected readonly core = new CameraButtonCore();
  protected readonly stateAttrMap = CameraButtonDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectCaptureTracks);
  protected override readonly hotkeyAction = 'toggleCameraMuted';

  protected activate(state: MediaCaptureTracksState): void {
    this.core.toggle(state);
  }
}
