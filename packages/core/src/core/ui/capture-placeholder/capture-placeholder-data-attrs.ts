import type { StateAttrMap } from '../types';
import type { CapturePlaceholderState } from './capture-placeholder-core';

export const CapturePlaceholderDataAttrs = {
  /** Current capture lifecycle. */
  captureState: 'data-capture-state',
} as const satisfies StateAttrMap<CapturePlaceholderState>;
