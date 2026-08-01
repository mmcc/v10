import { describe, expect, it } from 'vitest';
import { isLiveTrack, isResolvedPresentation } from '../../types';
import { getTracksByType } from '../../utils/tracks';
import {
  applyMoqCatalogUpdate,
  type MoqAudioTrack,
  type MoqVideoTrack,
  moqCatalogToPresentation,
  moqTrackId,
  parseChannelConfig,
  parseMoqCatalog,
} from '../parse-catalog';

const SOURCE_URL = 'moqt://relay.example.com/live#msf:conference-alice--catalog';
const SESSION_URI = 'moqt://relay.example.com/live';

// Trimmed version of the msf-01 §5.6.1 example (time-aligned A/V, one quality).
const SIMPLE_CATALOG = JSON.stringify({
  version: '1',
  generatedAt: 1746104606044,
  tracks: [
    {
      name: '1080p-video',
      namespace: 'conference.example.com/conference123/alice',
      packaging: 'loc',
      isLive: true,
      targetLatency: 2000,
      role: 'video',
      renderGroup: 1,
      codec: 'av01.0.08M.10.0.110.09',
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 1500000,
    },
    {
      name: 'audio',
      namespace: 'conference.example.com/conference123/alice',
      packaging: 'loc',
      isLive: true,
      targetLatency: 2000,
      role: 'audio',
      renderGroup: 1,
      codec: 'opus',
      samplerate: 48000,
      channelConfig: '2',
      bitrate: 32000,
    },
  ],
});

describe('parseMoqCatalog', () => {
  it('parses the simple A/V catalog into a resolved presentation of live tracks', () => {
    const presentation = parseMoqCatalog(SIMPLE_CATALOG, { url: SOURCE_URL });

    expect(isResolvedPresentation(presentation)).toBe(true);
    const videoTracks = getTracksByType(presentation, 'video');
    const audioTracks = getTracksByType(presentation, 'audio');
    expect(videoTracks).toHaveLength(1);
    expect(audioTracks).toHaveLength(1);

    const video = videoTracks[0] as MoqVideoTrack;
    expect(isLiveTrack(video)).toBe(true);
    expect(video).toMatchObject({
      type: 'video',
      deliveryMode: 'push',
      bandwidth: 1_500_000,
      width: 1920,
      height: 1080,
      codecs: ['av01.0.08M.10.0.110.09'],
      moq: {
        namespace: ['conference.example.com', 'conference123', 'alice'],
        name: '1080p-video',
        isLive: true,
        targetLatency: 2000,
      },
    });

    const audio = audioTracks[0] as MoqAudioTrack;
    expect(audio).toMatchObject({
      type: 'audio',
      deliveryMode: 'push',
      sampleRate: 48_000,
      channels: 2,
      codecs: ['opus'],
    });
    // Raw values ride along so `toAudioDecoderConfig` can tell a declared
    // rate from the projection's substituted one.
    expect(audio.moq).toMatchObject({ samplerate: 48_000, channelConfig: '2' });
  });

  // §5.2.9. The publisher's own statement of the minimum buffer a
  // receiver has to hold; the adaptive latency controller reads it as one
  // additive term of its margin, and nothing else in the engine does.
  it('carries the declared jitter through to the moq side-channel', () => {
    const catalog = JSON.stringify({
      version: '1',
      tracks: [
        {
          name: 'video',
          namespace: 'live',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.42001f',
          width: 640,
          height: 360,
          framerate: 30,
          jitter: 34,
        },
      ],
    });
    const presentation = parseMoqCatalog(catalog, { url: SOURCE_URL });
    const video = getTracksByType(presentation, 'video')[0] as MoqVideoTrack;
    expect(video.moq.jitter).toBe(34);
  });

  it('leaves jitter absent when the catalog declares none', () => {
    const presentation = parseMoqCatalog(SIMPLE_CATALOG, { url: SOURCE_URL });
    const video = getTracksByType(presentation, 'video')[0] as MoqVideoTrack;
    expect(video.moq.jitter).toBeUndefined();
  });

  it('sums dotted surround channel configurations', () => {
    expect(parseChannelConfig('2')).toBe(2);
    // `parseInt('5.1')` reads 5 and silently drops the LFE channel.
    expect(parseChannelConfig('5.1')).toBe(6);
    expect(parseChannelConfig('7.1.4')).toBe(12);
  });

  it('does not guess stereo for an absent or unrecognized channelConfig', () => {
    expect(parseChannelConfig(undefined)).toBeUndefined();
    // A codec-specific or otherwise unrecognized layout string — callers
    // decide whether/how to substitute, this parser doesn't guess.
    expect(parseChannelConfig('stereo')).toBeUndefined();
  });

  it('rejects a malformed or hostile channelConfig total instead of overflowing', () => {
    // `Number('9'.repeat(400))` overflows `Number.MAX_VALUE` to `Infinity`;
    // that must not sail through as a channel count.
    expect(parseChannelConfig('9'.repeat(400))).toBeUndefined();
    expect(parseChannelConfig('0')).toBeUndefined();
    // Comfortably past any real-world layout — guards the sane upper bound.
    expect(parseChannelConfig('1000')).toBeUndefined();
  });

  it('substitutes a conventional channel count in the projection while keeping the raw channelConfig', () => {
    // `AudioTrack.channels` is a required number, so the projection still
    // needs a value even for a layout `parseChannelConfig` can't resolve —
    // but the raw string rides along on `moq.channelConfig` so
    // `toAudioDecoderConfig` can tell "declared 2" from "unresolved" and
    // reject rather than silently decode as stereo.
    const text = JSON.stringify({
      version: '1',
      tracks: [
        {
          name: 'audio',
          packaging: 'loc',
          isLive: true,
          role: 'audio',
          codec: 'mp4a.40.2',
          samplerate: 44_100,
          channelConfig: 'JOC',
        },
      ],
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const audio = getTracksByType(presentation, 'audio')[0] as MoqAudioTrack;
    expect(audio.channels).toBe(2);
    expect(audio.moq.channelConfig).toBe('JOC');
  });

  it('derives stable track ids from full track names', () => {
    const first = parseMoqCatalog(SIMPLE_CATALOG, { url: SOURCE_URL });
    const second = parseMoqCatalog(SIMPLE_CATALOG, { url: SOURCE_URL });
    expect(getTracksByType(first, 'video')[0]!.id).toBe(getTracksByType(second, 'video')[0]!.id);
    expect(first.id).toBe(second.id);
  });

  it('inherits the catalog track namespace when a track omits its own', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' }],
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const video = getTracksByType(presentation, 'video')[0] as MoqVideoTrack;
    expect(video.moq.namespace).toEqual(['conference', 'alice']);
    expect(video.id).toBe(moqTrackId(['conference', 'alice'], 'video'));
  });

  it('maps caption/subtitle roles to text tracks and skips non-media tracks', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [
        { name: 'subs', packaging: 'loc', isLive: true, role: 'subtitle', label: 'English', lang: 'en' },
        { name: 'timeline', packaging: 'mediatimeline', isLive: true },
        { name: 'logs', packaging: 'moqlog', isLive: true, role: 'log' },
      ],
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const textTracks = getTracksByType(presentation, 'text');
    expect(textTracks).toHaveLength(1);
    expect(textTracks[0]).toMatchObject({ type: 'text', kind: 'subtitles', label: 'English', language: 'en' });
    expect(presentation.selectionSets).toHaveLength(1);
  });

  it('resolves initRef against the initialization data list', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [
        { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', initRef: 'init1' },
      ],
      initDataList: [{ id: 'init1', type: 'inline', data: btoa('\x01\x02\x03') }],
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const video = getTracksByType(presentation, 'video')[0] as MoqVideoTrack;
    expect(video.moq.initData).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('substitutes fragment variables into catalog string fields (§5.4)', () => {
    const text = JSON.stringify({
      version: '1',
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.64001f',
          authInfo: { cat: '%token%' },
        },
      ],
    });
    const presentation = parseMoqCatalog(text, { url: `${SOURCE_URL}&token=XYZ789` });
    const video = getTracksByType(presentation, 'video')[0] as MoqVideoTrack;
    expect(video.moq.authInfo).toEqual({ cat: 'XYZ789' });
  });

  it('throws on catalogs without version or tracks', () => {
    expect(() => parseMoqCatalog(JSON.stringify({ tracks: [] }), { url: SOURCE_URL })).toThrow();
    expect(() => parseMoqCatalog(JSON.stringify({ version: '1' }), { url: SOURCE_URL })).toThrow();
  });

  it('rejects catalog versions it does not understand (§5.1.1)', () => {
    expect(() => parseMoqCatalog(JSON.stringify({ version: 'draft-99', tracks: [] }), { url: SOURCE_URL })).toThrow(
      /unsupported MSF catalog version/
    );
  });

  it('accepts the draft-01 version', () => {
    const text = JSON.stringify({
      version: 'draft-01',
      tracks: [{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' }],
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    expect(getTracksByType(presentation, 'video')).toHaveLength(1);
  });
});

describe('applyMoqCatalogUpdate', () => {
  const options = { catalogNamespace: ['conference', 'alice'] };

  it('applies add and remove delta operations in order', () => {
    const initial = applyMoqCatalogUpdate(undefined, SIMPLE_CATALOG, options);
    expect(initial.tracks).toHaveLength(2);

    const delta = JSON.stringify({
      version: '1',
      deltaUpdate: [
        { op: 'remove', tracks: [{ name: 'audio', namespace: 'conference.example.com/conference123/alice' }] },
        {
          op: 'add',
          tracks: [
            {
              name: '720p-video',
              packaging: 'loc',
              isLive: true,
              role: 'video',
              codec: 'avc1.64001f',
              bitrate: 800000,
            },
          ],
        },
      ],
    });
    const updated = applyMoqCatalogUpdate(initial, delta, options);
    expect(updated.tracks.map((track) => track.name)).toEqual(['1080p-video', '720p-video']);
  });

  it('clones a parent track with overrides, inheriting everything not redefined (§5.1.6)', () => {
    // catalogNamespace differs from the parent's namespace so inheritance
    // is distinguishable from the fallback.
    const cloneOptions = { catalogNamespace: ['other', 'catalog'] };
    const initial = applyMoqCatalogUpdate(undefined, SIMPLE_CATALOG, cloneOptions);
    const delta = JSON.stringify({
      version: '1',
      deltaUpdate: [
        {
          op: 'clone',
          tracks: [
            {
              parentName: '1080p-video',
              parentNamespace: 'conference.example.com/conference123/alice',
              name: '540p-video',
              width: 960,
              height: 540,
              bitrate: 700000,
            },
          ],
        },
      ],
    });
    const updated = applyMoqCatalogUpdate(initial, delta, cloneOptions);
    const clone = updated.tracks.find((track) => track.name === '540p-video');
    expect(clone).toMatchObject({
      name: '540p-video',
      namespace: ['conference.example.com', 'conference123', 'alice'], // inherited
      packaging: 'loc', // inherited
      isLive: true, // inherited
      codec: 'av01.0.08M.10.0.110.09', // inherited
      width: 960, // overridden
      bitrate: 700000,
    });

    const presentation = moqCatalogToPresentation(updated, { url: SOURCE_URL }, SESSION_URI);
    const videoIds = getTracksByType(presentation, 'video').map((track) => track.id);
    expect(videoIds).toContain(moqTrackId(['conference.example.com', 'conference123', 'alice'], '540p-video'));
  });

  it('resolves a delta-added track initRef against the delta root initDataList', () => {
    const initial = applyMoqCatalogUpdate(undefined, SIMPLE_CATALOG, options);
    const delta = JSON.stringify({
      version: '1',
      deltaUpdate: [
        {
          op: 'add',
          tracks: [
            { name: 'hevc', packaging: 'loc', isLive: true, role: 'video', codec: 'hvc1.1.6.L93.B0', initRef: 'i2' },
          ],
        },
      ],
      initDataList: [{ id: 'i2', type: 'inline', data: btoa('\x0a\x0b') }],
    });
    const updated = applyMoqCatalogUpdate(initial, delta, options);
    const added = updated.tracks.find((track) => track.name === 'hevc');
    expect(added?.initData).toEqual(new Uint8Array([0x0a, 0x0b]));
  });

  it('resolves a delta-added track initRef against the base catalog initDataList', () => {
    const base = JSON.stringify({
      version: '1',
      tracks: [
        { name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', initRef: 'init1' },
      ],
      initDataList: [{ id: 'init1', type: 'inline', data: btoa('\x01\x02\x03') }],
    });
    const initial = applyMoqCatalogUpdate(undefined, base, options);
    const delta = JSON.stringify({
      version: '1',
      deltaUpdate: [
        {
          op: 'add',
          tracks: [
            { name: 'video-2', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', initRef: 'init1' },
          ],
        },
      ],
    });
    const updated = applyMoqCatalogUpdate(initial, delta, options);
    const added = updated.tracks.find((track) => track.name === 'video-2');
    expect(added?.initData).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a delta update with no prior catalog', () => {
    const delta = JSON.stringify({ version: '1', deltaUpdate: [] });
    expect(() => applyMoqCatalogUpdate(undefined, delta, options)).toThrow();
  });

  it('replaces state on an independent catalog', () => {
    const initial = applyMoqCatalogUpdate(undefined, SIMPLE_CATALOG, options);
    const replacement = JSON.stringify({
      version: '1',
      tracks: [{ name: 'only', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' }],
    });
    const replaced = applyMoqCatalogUpdate(initial, replacement, options);
    expect(replaced.tracks.map((track) => track.name)).toEqual(['only']);
  });
});

describe('moqCatalogToPresentation', () => {
  it('keeps ids stable across updates so selection equality holds', () => {
    const options = { catalogNamespace: ['conference', 'alice'] };
    const catalog = applyMoqCatalogUpdate(undefined, SIMPLE_CATALOG, options);
    const before = moqCatalogToPresentation(catalog, { url: SOURCE_URL }, SESSION_URI);

    const delta = JSON.stringify({
      version: '1',
      deltaUpdate: [
        { op: 'add', tracks: [{ name: 'extra', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f' }] },
      ],
    });
    const after = moqCatalogToPresentation(
      applyMoqCatalogUpdate(catalog, delta, options),
      { url: SOURCE_URL },
      SESSION_URI
    );

    const beforeIds = getTracksByType(before, 'video').map((track) => track.id);
    const afterIds = getTracksByType(after, 'video').map((track) => track.id);
    expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
  });
});
