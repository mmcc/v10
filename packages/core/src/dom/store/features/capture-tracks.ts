import type { MediaCaptureTracksState } from '@videojs/media';
import { isMediaCaptureToggleCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';

import { definePlayerFeature } from '../../feature';

export const captureTracksFeature = definePlayerFeature({
  name: 'captureTracks',
  state: ({ target }): MediaCaptureTracksState => ({
    cameraMuted: false,
    micMuted: false,

    setCameraMuted(muted) {
      const { media } = target();
      if (!isMediaCaptureToggleCapable(media)) return;

      media.cameraMuted = muted;
    },

    toggleCameraMuted() {
      const { media } = target();
      if (!isMediaCaptureToggleCapable(media)) return false;

      media.cameraMuted = !media.cameraMuted;
      return media.cameraMuted;
    },

    setMicMuted(muted) {
      const { media } = target();
      if (!isMediaCaptureToggleCapable(media)) return;

      media.micMuted = muted;
    },

    toggleMicMuted() {
      const { media } = target();
      if (!isMediaCaptureToggleCapable(media)) return false;

      media.micMuted = !media.micMuted;
      return media.micMuted;
    },
  }),

  attach({ target, signal, set }) {
    const { media } = target;
    if (!isMediaCaptureToggleCapable(media)) return;

    const sync = () =>
      set({
        cameraMuted: media.cameraMuted,
        micMuted: media.micMuted,
      });

    sync();

    listen(media, 'capturetogglechange', sync, { signal });
  },
});
