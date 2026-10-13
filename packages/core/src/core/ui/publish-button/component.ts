import { defineComponent } from 'vjsc/components';

import type { PublishButtonProps } from './core';
import { PublishButtonDataAttrs } from './data';

export default defineComponent<PublishButtonProps>({
  name: 'PublishButton',
  dataAttrs: PublishButtonDataAttrs,
});
