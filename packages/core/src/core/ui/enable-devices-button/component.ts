import { defineComponent } from 'vjsc/components';

import type { EnableDevicesButtonProps } from './core';
import { EnableDevicesButtonDataAttrs } from './data';

export default defineComponent<EnableDevicesButtonProps>({
  name: 'EnableDevicesButton',
  dataAttrs: EnableDevicesButtonDataAttrs,
});
