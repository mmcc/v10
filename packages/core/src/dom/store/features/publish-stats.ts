import type { MediaConnectionQuality, MediaPublishStats, MediaPublishStatsState } from '@videojs/media';
import { isMediaPublishStatsCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';
import { definePlayerFeature } from '../../feature';

/** Encoded FPS below this reads as a struggling encoder or capture pipeline. */
const LOW_ENCODED_FPS = 15;

/**
 * Bucket publish stats into a coarse connection quality.
 *
 * `unknown` until stats exist and report a real bitrate; `poor` when frames
 * were dropped this sample while the encoder is also below
 * {@link LOW_ENCODED_FPS}; `fair` when only one of those holds; `good`
 * otherwise.
 */
export function deriveConnectionQuality(
  stats: MediaPublishStats | null,
  previousDroppedFrames: number
): MediaConnectionQuality {
  if (!stats || Number.isNaN(stats.videoBitrate)) return 'unknown';

  const droppedFramesGrew = stats.droppedFrames > previousDroppedFrames;
  const lowEncodedFps = stats.encodedFps < LOW_ENCODED_FPS;

  if (droppedFramesGrew && lowEncodedFps) return 'poor';
  if (droppedFramesGrew || lowEncodedFps) return 'fair';
  return 'good';
}

export const publishStatsFeature = definePlayerFeature({
  name: 'publishStats',
  state: (): MediaPublishStatsState => ({
    publishStats: null,
    connectionQuality: 'unknown',
  }),

  attach({ target, signal, set }) {
    const { media } = target;

    if (!isMediaPublishStatsCapable(media)) return;

    // Seed from any pre-existing sample so a mid-session (re-)attach doesn't
    // read historical drops as fresh degradation.
    let previousDroppedFrames = media.publishStats?.droppedFrames ?? 0;

    const sync = () => {
      const stats = media.publishStats;

      if (!stats) {
        // The engine reset stats (session teardown) — drop back to defaults
        // and re-arm the baseline for the next session's counters.
        previousDroppedFrames = 0;
        set({ publishStats: null, connectionQuality: 'unknown' });
        return;
      }

      set({
        publishStats: stats,
        connectionQuality: deriveConnectionQuality(stats, previousDroppedFrames),
      });
      previousDroppedFrames = stats.droppedFrames;
    };

    sync();

    listen(media, 'publishstatsupdate', sync, { signal });
  },
});
