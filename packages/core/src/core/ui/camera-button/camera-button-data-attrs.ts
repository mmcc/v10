import type { StateAttrMap } from '../types';
import type { CameraButtonState } from './camera-button-core';

export const CameraButtonDataAttrs = {
  /** Present when outgoing video is muted. */
  cameraMuted: 'data-muted',
} as const satisfies StateAttrMap<CameraButtonState>;
