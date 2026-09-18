import { MicButtonCore, MicButtonDataAttrs } from '@videojs/core';
import { selectCaptureTracks } from '@videojs/core/dom';
import type { MediaCaptureTracksState } from '@videojs/media';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaButtonElement } from '../media-button-element';

export class MicButtonElement extends MediaButtonElement<MicButtonCore> {
  static readonly tagName = 'media-mic-button';

  protected readonly core = new MicButtonCore();
  protected readonly stateAttrMap = MicButtonDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectCaptureTracks);
  protected override readonly hotkeyAction = 'toggleMicMuted';

  protected activate(state: MediaCaptureTracksState): void {
    this.core.toggle(state);
  }
}
