import type { StateAttrMap } from '../types';
import type { EnableDevicesButtonState } from './core';

export const EnableDevicesButtonDataAttrs = {
  /** Current capture lifecycle. */
  captureState: 'data-capture-state',
  /** Present when the button is disabled. */
  disabled: 'data-disabled',
} as const satisfies StateAttrMap<EnableDevicesButtonState>;
