import type { MediaCaptureState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { captureSourceFeature } from '../capture-source';

interface CaptureSourceCapableMedia extends EventTarget {
  cameraActive: boolean;
  screenShareActive: boolean;
  cameraState: MediaCaptureState;
  screenShareState: MediaCaptureState;
  micState: MediaCaptureState;
}

function createCaptureMedia(initial: Partial<CaptureSourceCapableMedia> = {}): CaptureSourceCapableMedia {
  const media = new EventTarget() as CaptureSourceCapableMedia;
  media.cameraActive = initial.cameraActive ?? false;
  media.screenShareActive = initial.screenShareActive ?? false;
  media.cameraState = initial.cameraState ?? 'idle';
  media.screenShareState = initial.screenShareState ?? 'idle';
  media.micState = initial.micState ?? 'idle';
  return media;
}

function stubGetDisplayMedia(): () => void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia: () => Promise.resolve() },
    configurable: true,
  });
  return () => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  };
}

describe('captureSourceFeature', () => {
  describe('fallback (media without capture-source capability)', () => {
    it('stays at defaults when the media is not capture-source capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: video, container: null });

      expect(store.state.cameraActive).toBe(false);
      expect(store.state.screenShareActive).toBe(false);
      expect(store.state.cameraState).toBe('idle');
      expect(store.state.screenShareState).toBe('idle');
      expect(store.state.screenShareAvailability).toBe('unavailable');
    });

    it('no-ops actions when the media is not capture-source capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: video, container: null });

      expect(store.toggleCamera()).toBe(false);
      expect(store.toggleScreenShare()).toBe(false);
    });
  });

  describe('capable media', () => {
    it('reads initial values on attach', () => {
      const media = createCaptureMedia({ cameraActive: true, cameraState: 'active' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.cameraActive).toBe(true);
      expect(store.state.cameraState).toBe('active');
      expect(store.state.screenShareActive).toBe(false);
    });

    it('reports `unsupported` when `getDisplayMedia` is absent', () => {
      const media = createCaptureMedia();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.screenShareAvailability).toBe('unsupported');
    });

    describe('with `getDisplayMedia` present', () => {
      let restore: () => void;

      afterEach(() => restore());

      it('reports `available`', () => {
        restore = stubGetDisplayMedia();
        const media = createCaptureMedia();

        const store = createStore<PlayerTarget>()(captureSourceFeature);
        store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

        expect(store.state.screenShareAvailability).toBe('available');
      });
    });

    it('re-reads on `capturesourcechange`', () => {
      const media = createCaptureMedia();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.screenShareActive = true;
      media.dispatchEvent(new Event('capturesourcechange'));

      expect(store.state.screenShareActive).toBe(true);
    });

    it('re-reads on `capturestatechange`', () => {
      const media = createCaptureMedia({ cameraActive: true, cameraState: 'acquiring' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.cameraState = 'denied';
      media.dispatchEvent(new Event('capturestatechange'));

      expect(store.state.cameraState).toBe('denied');
    });

    it('defaults widened-contract fields an older media host lacks instead of storing undefined', () => {
      const media = createCaptureMedia({ cameraActive: true, cameraState: 'active' });
      // The capability predicate checks the core fields only — a host
      // predating micState still passes it.
      delete (media as { micState?: unknown }).micState;

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.micState).toBe('idle');
      expect(store.state.cameraState).toBe('active');
    });

    it('syncs the mic pipeline lifecycle on `capturestatechange`', () => {
      const media = createCaptureMedia({ cameraActive: true, micState: 'acquiring' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });
      expect(store.state.micState).toBe('acquiring');

      // A mic that dies mid-broadcast must be visible on the slice — it is
      // the only way a UI can say why a live broadcast has no sound.
      media.micState = 'ended';
      media.dispatchEvent(new Event('capturestatechange'));

      expect(store.state.micState).toBe('ended');
    });

    it('`toggleCamera()` flips the media camera intent and returns the new value', () => {
      const media = createCaptureMedia();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleCamera()).toBe(true);
      expect(media.cameraActive).toBe(true);

      expect(store.toggleCamera()).toBe(false);
      expect(media.cameraActive).toBe(false);
    });

    it('`toggleScreenShare()` flips independently of the camera — additive, not exclusive', () => {
      const media = createCaptureMedia({ cameraActive: true });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleScreenShare()).toBe(true);
      expect(media.screenShareActive).toBe(true);
      // The camera intent is untouched by the screen-share toggle.
      expect(media.cameraActive).toBe(true);

      expect(store.toggleScreenShare()).toBe(false);
      expect(media.screenShareActive).toBe(false);
      expect(media.cameraActive).toBe(true);
    });

    it('`toggleScreenShare()` starts sharing from a released source', () => {
      const media = createCaptureMedia({ cameraActive: false, screenShareActive: false });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleScreenShare()).toBe(true);
      expect(media.screenShareActive).toBe(true);
    });
  });
});
