import type { StateAttrMap } from '../types';
import type { ScreenShareButtonState } from './screen-share-button-core';

export const ScreenShareButtonDataAttrs = {
  /** Present when the screen is the active capture source. */
  sharing: 'data-sharing',
  /** Whether screen capture can be requested on this platform. */
  availability: 'data-availability',
} as const satisfies StateAttrMap<ScreenShareButtonState>;
