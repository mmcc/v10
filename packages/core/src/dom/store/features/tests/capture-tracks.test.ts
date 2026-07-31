import { createStore } from '@videojs/store';
import { describe, expect, it } from 'vitest';
import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { captureTracksFeature } from '../capture-tracks';

interface CaptureToggleCapableMedia extends EventTarget {
  cameraMuted: boolean;
  micMuted: boolean;
}

function createToggleMedia(initial: Partial<CaptureToggleCapableMedia> = {}): CaptureToggleCapableMedia {
  const media = new EventTarget() as CaptureToggleCapableMedia;
  media.cameraMuted = initial.cameraMuted ?? false;
  media.micMuted = initial.micMuted ?? false;
  return media;
}

describe('captureTracksFeature', () => {
  describe('fallback (media without capture-toggle capability)', () => {
    it('stays at defaults when the media is not capture-toggle capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: video, container: null });

      expect(store.state.cameraMuted).toBe(false);
      expect(store.state.micMuted).toBe(false);
    });

    it('no-ops actions when the media is not capture-toggle capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: video, container: null });

      expect(() => store.setCameraMuted(true)).not.toThrow();
      expect(() => store.setMicMuted(true)).not.toThrow();
      expect(store.toggleCameraMuted()).toBe(false);
      expect(store.toggleMicMuted()).toBe(false);
    });
  });

  describe('capable media', () => {
    it('reads initial values on attach', () => {
      const media = createToggleMedia({ cameraMuted: true, micMuted: false });

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.cameraMuted).toBe(true);
      expect(store.state.micMuted).toBe(false);
    });

    it('re-reads both on `capturetogglechange`', () => {
      const media = createToggleMedia();

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.cameraMuted = true;
      media.micMuted = true;
      media.dispatchEvent(new Event('capturetogglechange'));

      expect(store.state.cameraMuted).toBe(true);
      expect(store.state.micMuted).toBe(true);
    });

    it('`setCameraMuted()` writes the media camera muted state', () => {
      const media = createToggleMedia();

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.setCameraMuted(true);
      expect(media.cameraMuted).toBe(true);

      store.setCameraMuted(false);
      expect(media.cameraMuted).toBe(false);
    });

    it('`setMicMuted()` writes the media mic muted state', () => {
      const media = createToggleMedia();

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.setMicMuted(true);
      expect(media.micMuted).toBe(true);

      store.setMicMuted(false);
      expect(media.micMuted).toBe(false);
    });

    it('`toggleCameraMuted()` flips and returns the new value', () => {
      const media = createToggleMedia({ cameraMuted: false });

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleCameraMuted()).toBe(true);
      expect(media.cameraMuted).toBe(true);

      expect(store.toggleCameraMuted()).toBe(false);
      expect(media.cameraMuted).toBe(false);
    });

    it('`toggleMicMuted()` flips and returns the new value', () => {
      const media = createToggleMedia({ micMuted: true });

      const store = createStore<PlayerTarget>()(captureTracksFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.toggleMicMuted()).toBe(false);
      expect(media.micMuted).toBe(false);

      expect(store.toggleMicMuted()).toBe(true);
      expect(media.micMuted).toBe(true);
    });
  });
});
