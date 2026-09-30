import type { StateAttrMap } from '../types';
import type { PublishTimerState } from './publish-timer-core';

export const PublishTimerDataAttrs = {
  /** Current publish session lifecycle. */
  session: 'data-publish-state',
} as const satisfies StateAttrMap<PublishTimerState>;
