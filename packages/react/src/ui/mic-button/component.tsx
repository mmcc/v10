'use client';

import { MicButtonCore, MicButtonDataAttrs } from '@videojs/core';
import { selectCaptureTracks } from '@videojs/core/dom';

import type { UIComponentProps } from '../../utils/types';
import { createMediaButton } from '../create-media-button';

/** @internal */
export interface MicButtonProps extends UIComponentProps<'button', MicButtonCore.State>, MicButtonCore.Props {}

/**
 * A button that toggles whether outgoing capture audio is muted.
 *
 * @internal
 */
export const MicButton = createMediaButton<MicButtonCore, MicButtonProps>({
  displayName: 'MicButton',
  core: MicButtonCore,
  stateAttrMap: MicButtonDataAttrs,
  selector: selectCaptureTracks,
  action: (core, state) => core.toggle(state),
  hotkeyAction: 'toggleMicMuted',
});

/** @internal */
export namespace MicButton {
  export type Props = MicButtonProps;
  export type State = MicButtonCore.State;
}
