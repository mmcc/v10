import { describe, expect, it } from 'vitest';
import { EMPTY_REMOTE, EMPTY_TEXT_TRACKS, EMPTY_TIME_RANGES } from '../constants';
import {
  isMediaBufferCapable,
  isMediaCaptureDevicesCapable,
  isMediaCaptureSourceCapable,
  isMediaCaptureToggleCapable,
  isMediaPublishCapable,
  isMediaPublishStatsCapable,
  isMediaRemotePlaybackCapable,
  isMediaTextTrackCapable,
} from '../predicate';

describe('isMediaBufferCapable', () => {
  it('rejects empty time range stubs', () => {
    expect(isMediaBufferCapable({ buffered: EMPTY_TIME_RANGES, seekable: EMPTY_TIME_RANGES })).toBe(false);
  });

  it('accepts defined non-stub time ranges', () => {
    const range = { length: 1, start: () => 0, end: () => 10 };
    expect(isMediaBufferCapable({ buffered: range, seekable: range })).toBe(true);
  });
});

describe('isMediaTextTrackCapable', () => {
  it('rejects the empty text tracks stub', () => {
    expect(isMediaTextTrackCapable({ textTracks: EMPTY_TEXT_TRACKS })).toBe(false);
  });

  it('accepts defined non-stub text tracks', () => {
    expect(isMediaTextTrackCapable({ textTracks: Object.assign(new EventTarget(), { length: 0 }) })).toBe(true);
  });
});

describe('isMediaRemotePlaybackCapable', () => {
  it('rejects the empty remote playback stub', () => {
    expect(isMediaRemotePlaybackCapable({ remote: EMPTY_REMOTE })).toBe(false);
  });

  it('accepts defined non-stub remote playback', () => {
    expect(isMediaRemotePlaybackCapable({ remote: new EventTarget() })).toBe(true);
  });
});

describe('isMediaPublishCapable', () => {
  it('rejects playback-only media', () => {
    expect(isMediaPublishCapable({ paused: true, play: () => Promise.resolve() })).toBe(false);
  });

  it('requires publishState plus publish/unpublish functions', () => {
    expect(isMediaPublishCapable({ publishState: 'idle', publish: () => Promise.resolve() })).toBe(false);
    expect(isMediaPublishCapable({ publishState: 'idle', publish: () => Promise.resolve(), unpublish: () => {} })).toBe(
      true
    );
  });
});

describe('isMediaCaptureSourceCapable', () => {
  it('accepts released capture (both sources inactive) as still capable', () => {
    expect(isMediaCaptureSourceCapable({ cameraActive: false, cameraState: 'idle', screenShareState: 'idle' })).toBe(
      true
    );
  });

  it('rejects media without a screenShareState', () => {
    expect(isMediaCaptureSourceCapable({ cameraActive: true, cameraState: 'active' })).toBe(false);
  });

  it('rejects media without a cameraState', () => {
    expect(isMediaCaptureSourceCapable({ cameraActive: true, screenShareState: 'idle' })).toBe(false);
  });
});

describe('isMediaCaptureDevicesCapable', () => {
  it('requires the device list and both selections', () => {
    expect(isMediaCaptureDevicesCapable({ captureDevices: [] })).toBe(false);
    expect(isMediaCaptureDevicesCapable({ captureDevices: [], videoInputDeviceId: '', audioInputDeviceId: '' })).toBe(
      true
    );
  });
});

describe('isMediaCaptureToggleCapable', () => {
  it('requires both mute flags', () => {
    expect(isMediaCaptureToggleCapable({ cameraMuted: false })).toBe(false);
    expect(isMediaCaptureToggleCapable({ cameraMuted: false, micMuted: false })).toBe(true);
  });
});

describe('isMediaPublishStatsCapable', () => {
  it('accepts a null stats value (no sample yet is still capable)', () => {
    expect(isMediaPublishStatsCapable({ publishStats: null })).toBe(true);
    expect(isMediaPublishStatsCapable({})).toBe(false);
  });
});
