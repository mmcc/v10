import type { StateAttrMap } from '../types';
import type { PublishBadgeState } from './publish-badge-core';

export const PublishBadgeDataAttrs = {
  /** Current publish session lifecycle. */
  session: 'data-publish-state',
} as const satisfies StateAttrMap<PublishBadgeState>;
