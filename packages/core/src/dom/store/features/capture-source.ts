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
    micActive: false,
    micExplicit: false,
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

    toggleMic() {
      const { media } = target();
      // The contract keeps `micActive` optional because the capability
      // predicate admits older hosts without the slot — writing one there
      // would create an inert expando that sync() reads back as real
      // intent.
      if (!isMediaCaptureSourceCapable(media) || !('micActive' in media)) return false;

      const next = !media.micActive;

      media.micActive = next;
      return next;
    },
  }),

  attach({ target, signal, set }) {
    const { media } = target;
    if (!isMediaCaptureSourceCapable(media)) return;

    set({
      screenShareAvailability: canScreenShare() ? 'available' : 'unsupported',
    });

    // Provenance latch behind `micExplicit`: the pipeline consumes
    // `micActive` on `denied`/`ended` while parking `micState` there, so
    // the explicit claim must survive that consumption — and reset the
    // moment a new (implied) lifecycle starts, so a video-driven mic never
    // inherits it. Known boundary: an explicit attempt that terminates
    // before this feature attaches (persisted denial rejecting before a
    // React passive effect runs) reads as implied on the first sync — the
    // host would have to persist provenance for the latch to recover it.
    let micExplicit = false;

    // Defaulted reads: the capability predicate checks presence of the
    // core fields, not the whole widened contract, so a media host from
    // an older generation may lack e.g. `micState` — the slice must never
    // hold `undefined` where UIs expect a lifecycle value.
    const sync = () => {
      const micActive = media.micActive ?? false;
      const micState = media.micState ?? 'idle';

      if (micActive) micExplicit = true;
      else if (micState !== 'denied' && micState !== 'ended') micExplicit = false;

      set({
        cameraActive: media.cameraActive ?? false,
        screenShareActive: media.screenShareActive ?? false,
        micActive,
        micExplicit,
        cameraState: media.cameraState ?? 'idle',
        screenShareState: media.screenShareState ?? 'idle',
        micState,
      });
    };

    sync();

    listen(media, 'capturesourcechange', sync, { signal });
    listen(media, 'capturestatechange', sync, { signal });
  },
});

/** Check if screen capture can be requested (absent on iOS Safari and insecure contexts). */
function canScreenShare(): boolean {
  return isFunction(navigator.mediaDevices?.getDisplayMedia);
}
