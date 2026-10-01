import type { StateAttrMap } from '../types';
import type { PublishBadgeState } from './core';

export const PublishBadgeDataAttrs = {
  /** Current publish session lifecycle. */
  session: 'data-publish-state',
} as const satisfies StateAttrMap<PublishBadgeState>;
