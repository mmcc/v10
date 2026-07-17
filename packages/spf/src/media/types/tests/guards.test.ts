import { describe, expect, it } from 'vitest';
import type {
  LiveVideoTrack,
  MaybeResolvedPresentation,
  PartiallyResolvedAudioTrack,
  PartiallyResolvedTextTrack,
  PartiallyResolvedVideoTrack,
  Presentation,
  VideoSwitchingSet,
  VideoTrack,
} from '../index';
import { hasPresentationDuration, isLiveTrack, isResolvedPresentation, isResolvedTrack } from '../index';

describe('Type Guards', () => {
  describe('isResolvedTrack', () => {
    it('returns true for resolved video track (has segments)', () => {
      const resolved: VideoTrack = {
        type: 'video',
        codecs: [],
        id: 'video-0',
        url: 'https://example.com/video.m3u8',
        bandwidth: 1400000,
        width: 1280,
        height: 720,
        frameRate: { frameRateNumerator: 30 },
        mimeType: 'video/mp4',
        startTime: 0,
        duration: 10,
        initialization: { url: 'https://example.com/init.mp4' },
        segments: [],
      };

      expect(isResolvedTrack(resolved)).toBe(true);
    });

    it('returns false for unresolved video track (no segments)', () => {
      const unresolved: PartiallyResolvedVideoTrack = {
        type: 'video',
        codecs: [],
        id: 'video-0',
        url: 'https://example.com/video.m3u8',
        bandwidth: 1400000,
        mimeType: 'video/mp4',
      };

      expect(isResolvedTrack(unresolved)).toBe(false);
    });

    it('narrows PartiallyResolvedVideoTrack | VideoTrack to VideoTrack', () => {
      const track: PartiallyResolvedVideoTrack | VideoTrack = {
        type: 'video',
        codecs: [],
        id: 'video-0',
        url: 'https://example.com/video.m3u8',
        bandwidth: 1400000,
        width: 1280,
        height: 720,
        frameRate: { frameRateNumerator: 30 },
        mimeType: 'video/mp4',
        startTime: 0,
        duration: 10,
        initialization: { url: 'https://example.com/init.mp4' },
        segments: [],
      };

      if (isResolvedTrack(track)) {
        // TypeScript should know track is VideoTrack here
        const segments = track.segments;
        expect(segments).toBeDefined();
      }
    });

    it('works for audio tracks', () => {
      const unresolved: PartiallyResolvedAudioTrack = {
        type: 'audio',
        id: 'audio-0',
        url: 'https://example.com/audio.m3u8',
        groupId: 'audio',
        name: 'Default',
        mimeType: 'audio/mp4',
        bandwidth: 0,
        sampleRate: 48000,
        channels: 2,
        codecs: [],
      };

      expect(isResolvedTrack(unresolved)).toBe(false);
    });

    it('works for text tracks', () => {
      const unresolved: PartiallyResolvedTextTrack = {
        type: 'text',
        id: 'text-0',
        url: 'https://example.com/subs.m3u8',
        groupId: 'subs',
        label: 'English',
        kind: 'subtitles',
        mimeType: 'text/vtt',
        bandwidth: 0,
        codecs: [],
      };

      expect(isResolvedTrack(unresolved)).toBe(false);
    });
  });

  describe('isLiveTrack', () => {
    const liveVideo: LiveVideoTrack = {
      type: 'video',
      id: 'video-0',
      url: 'moqt://relay.example.com/live/video-hd',
      bandwidth: 1400000,
      width: 1280,
      height: 720,
      mimeType: 'video/mp4',
      codecs: ['avc1.64001f'],
      deliveryMode: 'push',
    };

    it('returns true for a push-delivered live track', () => {
      expect(isLiveTrack(liveVideo)).toBe(true);
    });

    it('returns false for a partially resolved pull track (no deliveryMode)', () => {
      const unresolved: PartiallyResolvedVideoTrack = {
        type: 'video',
        codecs: [],
        id: 'video-0',
        url: 'https://example.com/video.m3u8',
        bandwidth: 1400000,
        mimeType: 'video/mp4',
      };

      expect(isLiveTrack(unresolved)).toBe(false);
    });

    it('returns false for a resolved pull track', () => {
      const resolved: VideoTrack = {
        type: 'video',
        codecs: [],
        id: 'video-0',
        url: 'https://example.com/video.m3u8',
        bandwidth: 1400000,
        mimeType: 'video/mp4',
        startTime: 0,
        duration: 10,
        initialization: { url: 'https://example.com/init.mp4' },
        segments: [],
      };

      expect(isLiveTrack(resolved)).toBe(false);
    });

    it('narrows PartiallyResolvedVideoTrack to LiveVideoTrack', () => {
      const track: PartiallyResolvedVideoTrack = liveVideo;

      if (isLiveTrack(track)) {
        // TypeScript should know track is LiveVideoTrack here
        const mode: 'push' = track.deliveryMode;
        expect(mode).toBe('push');
      } else {
        expect.unreachable('live track was not narrowed');
      }
    });

    it('is never resolved (a live track has no segments)', () => {
      expect(isResolvedTrack(liveVideo)).toBe(false);
    });

    it('is storable in a switching set without widening the model', () => {
      const switchingSet: VideoSwitchingSet = {
        id: 'video',
        type: 'video',
        tracks: [liveVideo],
      };

      expect(switchingSet.tracks).toHaveLength(1);
    });
  });

  describe('hasPresentationDuration', () => {
    it('returns true when presentation has duration', () => {
      const presentation: Presentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        startTime: 0,
        duration: 100,
        selectionSets: [],
      };

      expect(hasPresentationDuration(presentation)).toBe(true);
    });

    it('returns false when presentation has undefined duration', () => {
      const presentation: Presentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        startTime: 0,

        selectionSets: [],
      };

      expect(hasPresentationDuration(presentation)).toBe(false);
    });

    it('narrows type to include required duration', () => {
      const presentation: Presentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        startTime: 0,
        duration: 100,
        selectionSets: [],
      };

      if (hasPresentationDuration(presentation)) {
        // TypeScript knows duration is number (not undefined)
        const d: number = presentation.duration;
        expect(d).toBe(100);
      }
    });
  });

  describe('isResolvedPresentation', () => {
    it('returns false for undefined', () => {
      expect(isResolvedPresentation(undefined)).toBe(false);
    });

    it('returns false for an unresolved presentation (url only)', () => {
      const unresolved: MaybeResolvedPresentation = {
        url: 'https://example.com/master.m3u8',
      };
      expect(isResolvedPresentation(unresolved)).toBe(false);
    });

    it('returns false when id is set but selectionSets is missing', () => {
      // Guards against partial values that would crash downstream behaviors
      // when they access selectionSets — only `id` is not enough.
      const partial: MaybeResolvedPresentation = {
        url: 'https://example.com/master.m3u8',
        id: 'presentation-0',
      };
      expect(isResolvedPresentation(partial)).toBe(false);
    });

    it('returns false when selectionSets is set but id is missing', () => {
      const partial: MaybeResolvedPresentation = {
        url: 'https://example.com/master.m3u8',
        selectionSets: [],
      };
      expect(isResolvedPresentation(partial)).toBe(false);
    });

    it('returns true when both id and selectionSets are present', () => {
      const resolved: Presentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        startTime: 0,
        selectionSets: [],
      };
      expect(isResolvedPresentation(resolved)).toBe(true);
    });

    it('returns true when selectionSets is empty (still resolved)', () => {
      // Empty selectionSets is a valid resolved manifest (no playable tracks),
      // distinct from "selectionSets not yet known".
      const resolved: Presentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        startTime: 0,
        selectionSets: [],
      };
      expect(isResolvedPresentation(resolved)).toBe(true);
    });

    it('narrows MaybeResolvedPresentation to Presentation', () => {
      const presentation: MaybeResolvedPresentation = {
        id: 'presentation-0',
        url: 'https://example.com/master.m3u8',
        selectionSets: [],
      };

      if (isResolvedPresentation(presentation)) {
        // TypeScript should know presentation is Presentation here
        const id: string = presentation.id;
        const sets = presentation.selectionSets;
        expect(id).toBe('presentation-0');
        expect(sets).toBeDefined();
      }
    });
  });
});
