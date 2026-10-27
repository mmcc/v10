'use client';

import { CameraButtonCore, CameraButtonDataAttrs } from '@videojs/core';
import { selectCaptureTracks } from '@videojs/core/dom';

import type { UIComponentProps } from '../../utils/types';
import { createMediaButton } from '../create-media-button';

/** @internal */
export interface CameraButtonProps extends UIComponentProps<'button', CameraButtonCore.State>, CameraButtonCore.Props {}

/**
 * A button that toggles whether outgoing capture video is muted.
 *
 * @internal
 */
export const CameraButton = createMediaButton<CameraButtonCore, CameraButtonProps>({
  displayName: 'CameraButton',
  core: CameraButtonCore,
  stateAttrMap: CameraButtonDataAttrs,
  selector: selectCaptureTracks,
  action: (core, state) => core.toggle(state),
  hotkeyAction: 'toggleCameraMuted',
});

/** @internal */
export namespace CameraButton {
  export type Props = CameraButtonProps;
  export type State = CameraButtonCore.State;
}
