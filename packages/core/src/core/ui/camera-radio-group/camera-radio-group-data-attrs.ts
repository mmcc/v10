import type { StateAttrMap } from '../types';
import type { CameraRadioGroupState } from './camera-radio-group-core';

export const CameraRadioGroupDataAttrs = {
  /** Currently selected camera device id. */
  value: 'data-camera',
  /** Present when camera selection is disabled. */
  disabled: 'data-disabled',
  /** Indicates camera selection availability (`available` or `unavailable`). */
  availability: 'data-availability',
} as const satisfies StateAttrMap<CameraRadioGroupState>;
