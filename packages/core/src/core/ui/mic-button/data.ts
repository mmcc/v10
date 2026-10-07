import type { StateAttrMap } from '../types';
import type { MicButtonState } from './core';

export const MicButtonDataAttrs = {
  /** Present when outgoing audio is muted. */
  micMuted: 'data-muted',
} as const satisfies StateAttrMap<MicButtonState>;
