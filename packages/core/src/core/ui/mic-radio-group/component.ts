import { defineComponent } from 'vjsc/components';

import type { MicRadioGroupProps } from './core';
import { MicRadioGroupDataAttrs } from './data';

export default defineComponent({
  name: 'MicRadioGroup',
  parts: {
    Root: defineComponent<MicRadioGroupProps>(),
    Value: defineComponent(),
    Options: defineComponent(),
  },
  dataAttrs: MicRadioGroupDataAttrs,
});
