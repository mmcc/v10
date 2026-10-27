import { EnableDevicesButtonCore, EnableDevicesButtonDataAttrs, type EnableDevicesButtonState } from '@videojs/core';
import { selectCaptureSource } from '@videojs/core/dom';
import type { MediaCaptureSourceState } from '@videojs/media';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/controller';
import { MediaButtonElement } from '../media-button-element';

export class EnableDevicesButtonElement extends MediaButtonElement<EnableDevicesButtonState, MediaCaptureSourceState> {
  static readonly tagName = 'media-enable-devices-button';

  protected readonly core = new EnableDevicesButtonCore();
  protected readonly stateAttrMap = EnableDevicesButtonDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectCaptureSource);

  protected activate(state: MediaCaptureSourceState): void {
    this.core.activate(state);
  }
}
