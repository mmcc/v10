import type { MediaPublishState } from '@videojs/media';
import { isMediaPublishCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';

import { definePlayerFeature } from '../../feature';

export const publishFeature = definePlayerFeature({
  name: 'publish',
  state: ({ target }): MediaPublishState => ({
    publishState: 'idle',
    publishStartedAt: Number.NaN,
    publishError: null,

    publish() {
      const { media } = target();
      if (!isMediaPublishCapable(media)) return Promise.reject(new Error('Media is not publish capable'));

      return media.publish();
    },

    unpublish() {
      const { media } = target();

      if (isMediaPublishCapable(media)) media.unpublish();
    },
  }),

  attach({ target, signal, set }) {
    const { media } = target;
    if (!isMediaPublishCapable(media)) return;

    const sync = () =>
      set({
        publishState: media.publishState,
        publishStartedAt: media.publishStartedAt,
        publishError: media.publishError,
      });

    sync();

    listen(media, 'publishstatechange', sync, { signal });
  },
});
