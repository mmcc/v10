import type { StateAttrMap } from '../types';
import type { ConnectionIndicatorState } from './connection-indicator-core';

export const ConnectionIndicatorDataAttrs = {
  /** Coarse connection health (`unknown`, `good`, `fair`, or `poor`). */
  quality: 'data-quality',
} as const satisfies StateAttrMap<ConnectionIndicatorState>;
