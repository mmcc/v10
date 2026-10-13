import { defineComponent } from 'vjsc/components';

import type { CameraRadioGroupProps } from './core';
import { CameraRadioGroupDataAttrs } from './data';

export default defineComponent({
  name: 'CameraRadioGroup',
  parts: {
    Root: defineComponent<CameraRadioGroupProps>(),
    Value: defineComponent(),
    Options: defineComponent(),
  },
  dataAttrs: CameraRadioGroupDataAttrs,
});
