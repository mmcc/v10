import { defineComponent } from 'vjsc/components';

import type { CapturePlaceholderProps } from './core';
import { CapturePlaceholderDataAttrs } from './data';

export default defineComponent<CapturePlaceholderProps>({
  name: 'CapturePlaceholder',
  dataAttrs: CapturePlaceholderDataAttrs,
});
