import { describe, expect, it } from 'vite-plus/test';

import { isResolvedPresentation } from '../../types';
import { getTracksByType } from '../../utils/tracks';
import { buildMsfCatalog, MSF_CATALOG_VERSION } from '../build-catalog';
import { toAudioDecoderConfig, toVideoDecoderConfig } from '../codec-mapping';
import { type MoqAudioTrack, type MoqVideoTrack, parseMoqCatalog } from '../parse-catalog';

const NAMESPACE = ['live', 'abc123'];
// The subscriber-side view of the same publication: catalog track under
// the published namespace.
const SOURCE_URL = 'moqt://relay.example.com/moq#msf:live-abc123--catalog';

const AV_INPUT = {
  namespace: NAMESPACE,
  video: {
    name: 'video',
    codec: 'avc1.42E01F',
    width: 1280,
    height: 720,
    framerate: 30,
    bitrate: 2_500_000,
  },
  audio: {
    name: 'audio',
    codec: 'opus',
    samplerate: 48_000,
    channelConfig: '2',
    bitrate: 128_000,
  },
};

describe('buildMsfCatalog', () => {
  it('round-trips an avc1+opus catalog through parseMoqCatalog into decodable tracks', () => {
    const text = buildMsfCatalog(AV_INPUT);
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });

    expect(isResolvedPresentation(presentation)).toBe(true);
    const video = getTracksByType(presentation, 'video') as MoqVideoTrack[];
    const audio = getTracksByType(presentation, 'audio') as MoqAudioTrack[];

    expect(video).toHaveLength(1);
    expect(audio).toHaveLength(1);

    expect(video[0]!.id).toBe('live/abc123/video');
    expect(video[0]!.codecs).toEqual(['avc1.42E01F']);
    expect(video[0]!.width).toBe(1280);
    expect(video[0]!.height).toBe(720);
    expect(video[0]!.bandwidth).toBe(2_500_000);
    expect(video[0]!.deliveryMode).toBe('push');
    expect(video[0]!.moq).toMatchObject({
      namespace: NAMESPACE,
      name: 'video',
      packaging: 'loc',
      isLive: true,
      framerate: 30,
    });

    expect(audio[0]!.id).toBe('live/abc123/audio');
    expect(audio[0]!.codecs).toEqual(['opus']);
    expect(audio[0]!.sampleRate).toBe(48_000);
    expect(audio[0]!.channels).toBe(2);
    expect(audio[0]!.moq).toMatchObject({ samplerate: 48_000, channelConfig: '2' });

    // The codec mapping the playback engine feeds its decoders with.
    expect(toVideoDecoderConfig(video[0]!)).toEqual({
      codec: 'avc1.42E01F',
      codedWidth: 1280,
      codedHeight: 720,
    });
    expect(toAudioDecoderConfig(audio[0]!)).toEqual({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
  });

  it('round-trips a vp8 video track', () => {
    const text = buildMsfCatalog({
      namespace: NAMESPACE,
      video: { name: 'video', codec: 'vp8', width: 640, height: 480, framerate: 24, bitrate: 1_000_000 },
    });
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });

    const video = getTracksByType(presentation, 'video') as MoqVideoTrack[];

    expect(video).toHaveLength(1);
    expect(getTracksByType(presentation, 'audio')).toHaveLength(0);
    expect(video[0]!.codecs).toEqual(['vp8']);
    expect(toVideoDecoderConfig(video[0]!)).toEqual({ codec: 'vp8', codedWidth: 640, codedHeight: 480 });
  });

  it('round-trips camera + screen into separate, non-alternate video switching sets', () => {
    const text = buildMsfCatalog({
      ...AV_INPUT,
      // Screen tuning: bigger frame, lower framerate, cheaper than the camera
      // — exactly the shape that made the bandwidth ranker treat it as the
      // camera's downgrade while both shared one switching set.
      screen: { name: 'screen', codec: 'avc1.42E01F', width: 1920, height: 1080, framerate: 5, bitrate: 800_000 },
    });

    const raw = JSON.parse(text);

    // The pair the parse side reads: rendered together, never alternates.
    expect(raw.tracks.every((track: Record<string, unknown>) => track.renderGroup === 1)).toBe(true);
    expect(raw.tracks.some((track: Record<string, unknown>) => 'altGroup' in track)).toBe(false);

    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const videoSet = presentation.selectionSets.find((set) => set.type === 'video')!;

    expect(videoSet.switchingSets.map((switchingSet) => switchingSet.id)).toEqual([
      'moq-video-main',
      // Derived from the presentation-unique track id (namespace + name).
      'moq-video-live-abc123-screen',
    ]);
    // The camera is the rendered set, and the only one selection enumerates —
    // no throughput movement can put the screen share on screen.
    expect(getTracksByType(presentation, 'video').map((track) => track.id)).toEqual(['live/abc123/video']);
    expect(videoSet.switchingSets[1]!.tracks.map((track) => track.id)).toEqual(['live/abc123/screen']);
  });

  it('emits application data tracks that round-trip as non-renderable plumbing', () => {
    const text = buildMsfCatalog({
      ...AV_INPUT,
      data: [{ name: 'overlay', role: 'data' }, { name: 'events' }],
    });

    const raw = JSON.parse(text);
    const overlay = raw.tracks.find((track: Record<string, unknown>) => track.name === 'overlay');

    // Shared publication fields plus name + role — no media fields, and no
    // renderGroup (the track composes nothing on screen).
    expect(overlay).toEqual({
      namespace: 'live/abc123',
      packaging: 'loc',
      isLive: true,
      name: 'overlay',
      role: 'data',
    });
    const events = raw.tracks.find((track: Record<string, unknown>) => track.name === 'events');

    expect(events).not.toHaveProperty('role');

    // The parse side classifies both as engine plumbing, not media: the
    // renderable track set is exactly what it was without them.
    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });

    expect(isResolvedPresentation(presentation)).toBe(true);
    expect(getTracksByType(presentation, 'video')).toHaveLength(1);
    expect(getTracksByType(presentation, 'audio')).toHaveLength(1);
    expect(getTracksByType(presentation, 'text')).toHaveLength(0);
  });

  it('round-trips track init data through initDataList + initRef into the decoder description', () => {
    const avcC = Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1]);
    const audioSpecificConfig = Uint8Array.from([0x11, 0x90]);
    const text = buildMsfCatalog({
      namespace: NAMESPACE,
      video: { ...AV_INPUT.video, initData: avcC },
      audio: { ...AV_INPUT.audio, codec: 'mp4a.40.2', initData: audioSpecificConfig },
    });

    // The wire shape §5.2.16-17 readers (and non-SPF consumers) parse:
    // inline base64 entries referenced per track.
    const raw = JSON.parse(text);

    expect(raw.tracks.map((track: Record<string, unknown>) => track.initRef)).toEqual(['video-init', 'audio-init']);
    expect(raw.initDataList).toEqual([
      { id: 'video-init', type: 'inline', data: btoa('\x01\x42\xc0\x1e\xff\xe1') },
      { id: 'audio-init', type: 'inline', data: btoa('\x11\x90') },
    ]);

    const presentation = parseMoqCatalog(text, { url: SOURCE_URL });
    const video = getTracksByType(presentation, 'video') as MoqVideoTrack[];
    const audio = getTracksByType(presentation, 'audio') as MoqAudioTrack[];

    expect(video[0]!.moq.initData).toEqual(avcC);
    expect(audio[0]!.moq.initData).toEqual(audioSpecificConfig);
    expect(new Uint8Array(toVideoDecoderConfig(video[0]!)!.description as ArrayBuffer)).toEqual(avcC);
    expect(new Uint8Array(toAudioDecoderConfig(audio[0]!)!.description as ArrayBuffer)).toEqual(audioSpecificConfig);
  });

  it('emits the supported version, completeness, and no absent fields', () => {
    const raw = JSON.parse(
      buildMsfCatalog({ namespace: NAMESPACE, audio: { name: 'audio', codec: 'opus' }, generatedAt: 1746104606044 })
    );

    expect(raw.version).toBe(MSF_CATALOG_VERSION);
    expect(raw.isComplete).toBe(true);
    expect(raw.generatedAt).toBe(1746104606044);
    expect(raw.tracks).toEqual([
      {
        namespace: 'live/abc123',
        packaging: 'loc',
        isLive: true,
        name: 'audio',
        role: 'audio',
        codec: 'opus',
      },
    ]);
  });
});
