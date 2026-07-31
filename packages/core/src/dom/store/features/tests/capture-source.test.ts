import type { MediaCaptureSourceKind, MediaCaptureState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { captureSourceFeature } from '../capture-source';

interface CaptureSourceCapableMedia extends EventTarget {
  captureSource: MediaCaptureSourceKind | null;
  captureState: MediaCaptureState;
}

function createCaptureMedia(initial: Partial<CaptureSourceCapableMedia> = {}): CaptureSourceCapableMedia {
  const media = new EventTarget() as CaptureSourceCapableMedia;
  media.captureSource = initial.captureSource ?? null;
  media.captureState = initial.captureState ?? 'idle';
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

      expect(store.state.captureSource).toBeNull();
      expect(store.state.captureState).toBe('idle');
      expect(store.state.screenShareAvailability).toBe('unavailable');
    });

    it('no-ops actions when the media is not capture-source capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: video, container: null });

      expect(() => store.selectCaptureSource('camera')).not.toThrow();
      expect(store.toggleScreenShare()).toBe(false);
    });
  });

  describe('capable media', () => {
    it('reads initial values on attach', () => {
      const media = createCaptureMedia({ captureSource: 'camera', captureState: 'active' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.captureSource).toBe('camera');
      expect(store.state.captureState).toBe('active');
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

      media.captureSource = 'screen';
      media.dispatchEvent(new Event('capturesourcechange'));

      expect(store.state.captureSource).toBe('screen');
    });

    it('re-reads on `capturestatechange`', () => {
      const media = createCaptureMedia({ captureSource: 'camera', captureState: 'acquiring' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.captureState = 'denied';
      media.dispatchEvent(new Event('capturestatechange'));

      expect(store.state.captureState).toBe('denied');
    });

    it('`selectCaptureSource()` writes the media capture source', () => {
      const media = createCaptureMedia();

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.selectCaptureSource('camera');
      expect(media.captureSource).toBe('camera');

      store.selectCaptureSource(null);
      expect(media.captureSource).toBeNull();
    });

    it('`toggleScreenShare()` flips camera to screen and returns `true`', () => {
      const media = createCaptureMedia({ captureSource: 'camera' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleScreenShare()).toBe(true);
      expect(media.captureSource).toBe('screen');
    });

    it('`toggleScreenShare()` flips screen to camera and returns `false`', () => {
      const media = createCaptureMedia({ captureSource: 'screen' });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleScreenShare()).toBe(false);
      expect(media.captureSource).toBe('camera');
    });

    it('`toggleScreenShare()` starts sharing from a released source', () => {
      const media = createCaptureMedia({ captureSource: null });

      const store = createStore<PlayerTarget>()(captureSourceFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleScreenShare()).toBe(true);
      expect(media.captureSource).toBe('screen');
    });
  });
});
