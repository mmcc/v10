import { defineComponent } from 'vjsc/components';

import type { PublishBadgeProps } from './core';
import { PublishBadgeDataAttrs } from './data';

export default defineComponent<PublishBadgeProps>({
  name: 'PublishBadge',
  dataAttrs: PublishBadgeDataAttrs,
});
