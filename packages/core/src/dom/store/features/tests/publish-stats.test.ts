import type { MediaPublishStats } from '@videojs/media';
import { createStore } from '@videojs/store';
import { describe, expect, it } from 'vitest';
import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { deriveConnectionQuality, publishStatsFeature } from '../publish-stats';

interface PublishStatsCapableMedia extends EventTarget {
  publishStats: MediaPublishStats | null;
}

function createStatsMedia(publishStats: MediaPublishStats | null = null): PublishStatsCapableMedia {
  const media = new EventTarget() as PublishStatsCapableMedia;
  media.publishStats = publishStats;
  return media;
}

function createStats(overrides: Partial<MediaPublishStats> = {}): MediaPublishStats {
  return {
    encodedFps: 30,
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    droppedFrames: 0,
    droppedGroups: 0,
    bytesSent: 0,
    subscriberCount: Number.NaN,
    ...overrides,
  };
}

describe('publishStatsFeature', () => {
  describe('fallback (media without publish-stats capability)', () => {
    it('stays at defaults when the media is not publish-stats capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: video, container: null });

      expect(store.state.publishStats).toBeNull();
      expect(store.state.connectionQuality).toBe('unknown');
    });
  });

  describe('capable media', () => {
    it('stays `unknown` while stats are null', () => {
      const media = createStatsMedia();

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.publishStats).toBeNull();
      expect(store.state.connectionQuality).toBe('unknown');
    });

    it('re-reads stats and derives quality on `publishstatsupdate`', () => {
      const media = createStatsMedia();

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      const stats = createStats();
      media.publishStats = stats;
      media.dispatchEvent(new Event('publishstatsupdate'));

      expect(store.state.publishStats).toBe(stats);
      expect(store.state.connectionQuality).toBe('good');
    });

    it('degrades quality when dropped frames grow between samples', () => {
      const media = createStatsMedia();

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.publishStats = createStats({ droppedFrames: 2 });
      media.dispatchEvent(new Event('publishstatsupdate'));
      expect(store.state.connectionQuality).toBe('fair');

      // No further growth this sample — back to good.
      media.publishStats = createStats({ droppedFrames: 2 });
      media.dispatchEvent(new Event('publishstatsupdate'));
      expect(store.state.connectionQuality).toBe('good');

      // Growth while the encoder is also slow — poor.
      media.publishStats = createStats({ droppedFrames: 10, encodedFps: 10 });
      media.dispatchEvent(new Event('publishstatsupdate'));
      expect(store.state.connectionQuality).toBe('poor');
    });

    it('resets to defaults when stats reset to null (session teardown)', () => {
      const media = createStatsMedia();

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.publishStats = createStats();
      media.dispatchEvent(new Event('publishstatsupdate'));
      expect(store.state.connectionQuality).toBe('good');

      media.publishStats = null;
      media.dispatchEvent(new Event('publishstatsupdate'));

      expect(store.state.publishStats).toBeNull();
      expect(store.state.connectionQuality).toBe('unknown');
    });

    it('does not degrade quality from historical dropped frames on attach', () => {
      // Re-attach mid-session: the media already reports cumulative drops.
      const media = createStatsMedia(createStats({ droppedFrames: 100 }));

      const store = createStore<PlayerTarget>()(publishStatsFeature);
      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      // The historical count seeds the baseline instead of reading as growth.
      expect(store.state.connectionQuality).toBe('good');

      // Fresh growth after attach still degrades.
      media.publishStats = createStats({ droppedFrames: 105 });
      media.dispatchEvent(new Event('publishstatsupdate'));
      expect(store.state.connectionQuality).toBe('fair');
    });
  });
});

describe('deriveConnectionQuality', () => {
  it('returns `unknown` for null stats', () => {
    expect(deriveConnectionQuality(null, 0)).toBe('unknown');
  });

  it('returns `unknown` when the video bitrate is NaN', () => {
    expect(deriveConnectionQuality(createStats({ videoBitrate: Number.NaN }), 0)).toBe('unknown');
  });

  it('returns `poor` when dropped frames grew and encoded FPS is low', () => {
    expect(deriveConnectionQuality(createStats({ droppedFrames: 5, encodedFps: 10 }), 0)).toBe('poor');
  });

  it('returns `fair` when only dropped frames grew', () => {
    expect(deriveConnectionQuality(createStats({ droppedFrames: 5 }), 0)).toBe('fair');
  });

  it('returns `fair` when only encoded FPS is low', () => {
    expect(deriveConnectionQuality(createStats({ encodedFps: 10 }), 0)).toBe('fair');
  });

  it('returns `good` for a healthy sample', () => {
    expect(deriveConnectionQuality(createStats({ droppedFrames: 5 }), 5)).toBe('good');
  });
});
