import { defineComponent } from 'vjsc/components';

import type { CameraButtonProps } from './core';
import { CameraButtonDataAttrs } from './data';

export default defineComponent<CameraButtonProps>({
  name: 'CameraButton',
  dataAttrs: CameraButtonDataAttrs,
});
