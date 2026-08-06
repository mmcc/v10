import type { MediaCaptureSourceState } from '@videojs/media';
import { isMediaCaptureSourceCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';
import { isFunction } from '@videojs/utils/predicate';
import { definePlayerFeature } from '../../feature';

export const captureSourceFeature = definePlayerFeature({
  name: 'captureSource',
  state: ({ target }): MediaCaptureSourceState => ({
    cameraActive: false,
    screenShareActive: false,
    cameraState: 'idle',
    screenShareState: 'idle',
    micState: 'idle',
    screenShareAvailability: 'unavailable',

    toggleCamera() {
      const { media } = target();
      if (!isMediaCaptureSourceCapable(media)) return false;
      const next = !media.cameraActive;
      media.cameraActive = next;
      return next;
    },

    toggleScreenShare() {
      const { media } = target();
      if (!isMediaCaptureSourceCapable(media)) return false;
      const next = !media.screenShareActive;
      media.screenShareActive = next;
      return next;
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
        cameraActive: media.cameraActive,
        screenShareActive: media.screenShareActive,
        cameraState: media.cameraState,
        screenShareState: media.screenShareState,
        micState: media.micState,
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
