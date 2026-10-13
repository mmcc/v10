import { defineComponent } from 'vjsc/components';

import type { ConnectionIndicatorProps } from './core';
import { ConnectionIndicatorDataAttrs } from './data';

export default defineComponent<ConnectionIndicatorProps>({
  name: 'ConnectionIndicator',
  dataAttrs: ConnectionIndicatorDataAttrs,
});
