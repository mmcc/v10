import { defineComponent } from 'vjsc/components';

import type { ScreenShareButtonProps } from './core';
import { ScreenShareButtonDataAttrs } from './data';

export default defineComponent<ScreenShareButtonProps>({
  name: 'ScreenShareButton',
  dataAttrs: ScreenShareButtonDataAttrs,
});
