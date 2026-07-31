import type { MediaCaptureSourceState } from '@videojs/media';
import { isMediaCaptureSourceCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';
import { isFunction } from '@videojs/utils/predicate';
import { definePlayerFeature } from '../../feature';

export const captureSourceFeature = definePlayerFeature({
  name: 'captureSource',
  state: ({ target }): MediaCaptureSourceState => ({
    captureSource: null,
    captureState: 'idle',
    screenShareAvailability: 'unavailable',

    selectCaptureSource(source) {
      const { media } = target();
      if (!isMediaCaptureSourceCapable(media)) return;
      media.captureSource = source;
    },

    toggleScreenShare() {
      const { media } = target();
      if (!isMediaCaptureSourceCapable(media)) return false;
      const sharing = media.captureSource === 'screen';
      media.captureSource = sharing ? 'camera' : 'screen';
      return !sharing;
    },
  }),

  attach({ target, signal, set }) {
    const { media } = target;

    if (!isMediaCaptureSourceCapable(media)) return;

    set({
      screenShareAvailability: canScreenShare() ? 'available' : 'unsupported',
    });

    const sync = () =>
      set({
        captureSource: media.captureSource,
        captureState: media.captureState,
      });

    sync();

    listen(media, 'capturesourcechange', sync, { signal });
    listen(media, 'capturestatechange', sync, { signal });
  },
});

/** Check if screen capture can be requested (absent on iOS Safari and insecure contexts). */
function canScreenShare(): boolean {
  return isFunction(navigator.mediaDevices?.getDisplayMedia);
}
