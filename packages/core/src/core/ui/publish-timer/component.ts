import { defineComponent } from 'vjsc/components';

import type { PublishTimerProps } from './core';
import { PublishTimerDataAttrs } from './data';

export default defineComponent<PublishTimerProps>({
  name: 'PublishTimer',
  dataAttrs: PublishTimerDataAttrs,
});
