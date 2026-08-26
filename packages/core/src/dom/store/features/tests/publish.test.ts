import type { ErrorLike, MediaPublishSessionState } from '@videojs/media';
import { createStore } from '@videojs/store';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { publishFeature } from '../publish';

interface PublishCapableMedia extends EventTarget {
  publishState: MediaPublishSessionState;
  publishStartedAt: number;
  publishError: ErrorLike | null;
  publish: ReturnType<typeof vi.fn>;
  unpublish: ReturnType<typeof vi.fn>;
}

function createPublishMedia(initial: Partial<PublishCapableMedia> = {}): PublishCapableMedia {
  const media = new EventTarget() as PublishCapableMedia;

  media.publishState = initial.publishState ?? 'idle';
  media.publishStartedAt = initial.publishStartedAt ?? Number.NaN;
  media.publishError = initial.publishError ?? null;
  media.publish = vi.fn(() => Promise.resolve());
  media.unpublish = vi.fn();
  return media;
}

describe('publishFeature', () => {
  describe('fallback (media without publish capability)', () => {
    it('stays at defaults when the media is not publish capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: video, container: null });

      expect(store.state.publishState).toBe('idle');
      expect(store.state.publishStartedAt).toBeNaN();
      expect(store.state.publishError).toBeNull();
    });

    it('rejects `publish()` when the media is not publish capable', async () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: video, container: null });

      await expect(store.publish()).rejects.toThrow('not publish capable');
    });

    it('no-ops `unpublish()` when the media is not publish capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: video, container: null });

      expect(() => store.unpublish()).not.toThrow();
    });
  });

  describe('capable media', () => {
    it('reads initial values on attach', () => {
      const media = createPublishMedia({ publishState: 'live', publishStartedAt: 1234 });

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.publishState).toBe('live');
      expect(store.state.publishStartedAt).toBe(1234);
    });

    it('re-reads both on `publishstatechange`', () => {
      const media = createPublishMedia();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.publishState = 'connecting';
      media.dispatchEvent(new Event('publishstatechange'));
      expect(store.state.publishState).toBe('connecting');
      expect(store.state.publishStartedAt).toBeNaN();

      media.publishState = 'live';
      media.publishStartedAt = 5678;
      media.dispatchEvent(new Event('publishstatechange'));
      expect(store.state.publishState).toBe('live');
      expect(store.state.publishStartedAt).toBe(5678);
    });

    it('syncs `publishError` on `publishstatechange`', () => {
      const media = createPublishMedia();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      const error: ErrorLike = { code: 3, message: 'relay unreachable' };

      media.publishState = 'error';
      media.publishError = error;
      media.dispatchEvent(new Event('publishstatechange'));

      expect(store.state.publishState).toBe('error');
      expect(store.state.publishError).toBe(error);

      // A successful retry clears the cause.
      media.publishState = 'connecting';
      media.publishError = null;
      media.dispatchEvent(new Event('publishstatechange'));

      expect(store.state.publishError).toBeNull();
    });

    it('reads a pre-existing `publishError` on attach', () => {
      const error: ErrorLike = { code: 1, message: 'capture failed' };
      const media = createPublishMedia({ publishState: 'error', publishError: error });

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.publishError).toBe(error);
    });

    it('`publish()` calls through to the media', async () => {
      const media = createPublishMedia();

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      await store.publish();

      expect(media.publish).toHaveBeenCalledTimes(1);
    });

    it('`unpublish()` calls through to the media', () => {
      const media = createPublishMedia({ publishState: 'live' });

      const store = createStore<PlayerTarget>()(publishFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.unpublish();

      expect(media.unpublish).toHaveBeenCalledTimes(1);
    });
  });
});
