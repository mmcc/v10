import { defineComponent } from 'vjsc/components';

import type { MicButtonProps } from './core';
import { MicButtonDataAttrs } from './data';

export default defineComponent<MicButtonProps>({
  name: 'MicButton',
  dataAttrs: MicButtonDataAttrs,
});
