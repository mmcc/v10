import type { StateAttrMap } from '../types';
import type { MicRadioGroupState } from './mic-radio-group-core';

export const MicRadioGroupDataAttrs = {
  /** Currently selected microphone device id. */
  value: 'data-microphone',
  /** Present when microphone selection is disabled. */
  disabled: 'data-disabled',
  /** Indicates microphone selection availability (`available` or `unavailable`). */
  availability: 'data-availability',
} as const satisfies StateAttrMap<MicRadioGroupState>;
