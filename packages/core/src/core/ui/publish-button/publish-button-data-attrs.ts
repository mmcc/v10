import type { StateAttrMap } from '../types';
import type { PublishButtonState } from './publish-button-core';

export const PublishButtonDataAttrs = {
  /** Current publish session lifecycle. */
  session: 'data-publish-state',
  /** Present when the button is disabled. */
  disabled: 'data-disabled',
} as const satisfies StateAttrMap<PublishButtonState>;
