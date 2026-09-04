'use client';

import { EnableDevicesButtonCore, EnableDevicesButtonDataAttrs } from '@videojs/core';
import { selectCaptureSource } from '@videojs/core/dom';

import type { UIComponentProps } from '../../utils/types';
import { createMediaButton } from '../create-media-button';

export interface EnableDevicesButtonProps
  extends UIComponentProps<'button', EnableDevicesButtonCore.State>, EnableDevicesButtonCore.Props {}

/**
 * A button that enables the camera and microphone by selecting the camera capture source, prompting for device
 * permission as needed. Disabled while capture is `acquiring`.
 */
export const EnableDevicesButton = createMediaButton<EnableDevicesButtonCore, EnableDevicesButtonProps>({
  displayName: 'EnableDevicesButton',
  core: EnableDevicesButtonCore,
  stateAttrMap: EnableDevicesButtonDataAttrs,
  selector: selectCaptureSource,
  action: (core, state) => core.activate(state),
});

export namespace EnableDevicesButton {
  export type Props = EnableDevicesButtonProps;
  export type State = EnableDevicesButtonCore.State;
}
