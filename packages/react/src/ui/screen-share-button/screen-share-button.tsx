'use client';

import { ScreenShareButtonCore, ScreenShareButtonDataAttrs } from '@videojs/core';
import { selectCaptureSource } from '@videojs/core/dom';

import type { UIComponentProps } from '../../utils/types';
import { createMediaButton } from '../create-media-button';

export interface ScreenShareButtonProps
  extends UIComponentProps<'button', ScreenShareButtonCore.State>,
    ScreenShareButtonCore.Props {}

/**
 * A button that toggles the capture source between the screen and the
 * camera. Exposes `data-availability` so skins can hide it where screen
 * capture is unsupported (e.g. iOS Safari).
 */
export const ScreenShareButton = createMediaButton<ScreenShareButtonCore, ScreenShareButtonProps>({
  displayName: 'ScreenShareButton',
  core: ScreenShareButtonCore,
  stateAttrMap: ScreenShareButtonDataAttrs,
  selector: selectCaptureSource,
  action: (core, state) => core.toggle(state),
});

export namespace ScreenShareButton {
  export type Props = ScreenShareButtonProps;
  export type State = ScreenShareButtonCore.State;
}
