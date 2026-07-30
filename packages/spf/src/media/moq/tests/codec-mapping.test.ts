import { describe, expect, it } from 'vitest';
import { toAudioDecoderConfig, toVideoDecoderConfig } from '../codec-mapping';
import type { MoqAudioTrack, MoqVideoTrack } from '../parse-catalog';

function videoTrack(overrides: Partial<MoqVideoTrack> = {}): MoqVideoTrack {
  return {
    type: 'video',
    id: 'ns/video',
    url: 'moqt://relay/live#msf:ns--video',
    mimeType: 'video/loc',
    bandwidth: 1_500_000,
    codecs: ['av01.0.08M.10.0.110.09'],
    width: 1920,
    height: 1080,
    deliveryMode: 'push',
    moq: { namespace: ['ns'], name: 'video', packaging: 'loc', isLive: true },
    ...overrides,
  };
}

function audioTrack(overrides: Partial<MoqAudioTrack> = {}): MoqAudioTrack {
  return {
    type: 'audio',
    id: 'ns/audio',
    url: 'moqt://relay/live#msf:ns--audio',
    mimeType: 'audio/loc',
    bandwidth: 32_000,
    codecs: ['opus'],
    groupId: 'audio',
    name: 'audio',
    sampleRate: 48_000,
    channels: 2,
    deliveryMode: 'push',
    moq: { namespace: ['ns'], name: 'audio', packaging: 'loc', isLive: true },
    ...overrides,
  };
}

describe('toVideoDecoderConfig', () => {
  it('projects codec and coded dimensions', () => {
    expect(toVideoDecoderConfig(videoTrack())).toEqual({
      codec: 'av01.0.08M.10.0.110.09',
      codedWidth: 1920,
      codedHeight: 1080,
    });
  });

  it('carries catalog init data as description', () => {
    const track = videoTrack();
    track.moq.initData = new Uint8Array([1, 2, 3]);
    const config = toVideoDecoderConfig(track)!;
    expect(new Uint8Array(config.description as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('returns null without a codec', () => {
    expect(toVideoDecoderConfig(videoTrack({ codecs: [] }))).toBeNull();
  });
});

describe('toAudioDecoderConfig', () => {
  it('projects codec, sample rate, and channel count', () => {
    expect(toAudioDecoderConfig(audioTrack())).toEqual({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 2,
    });
  });

  it('returns null without a codec', () => {
    expect(toAudioDecoderConfig(audioTrack({ codecs: [] }))).toBeNull();
  });

  // `AudioTrack.sampleRate` is required, so the projection substitutes 48000
  // when the catalog omits it. Trusting that would configure a 44.1 kHz AAC
  // decoder at 48 kHz and corrupt every frame instead of failing loudly.
  it('prefers the catalog samplerate over the projection substitute', () => {
    const track = audioTrack({
      codecs: ['mp4a.40.2'],
      sampleRate: 48_000,
      moq: { namespace: ['ns'], name: 'audio', packaging: 'loc', isLive: true, samplerate: 44_100 },
    });
    expect(toAudioDecoderConfig(track)).toMatchObject({ sampleRate: 44_100 });
  });

  it('returns null when a non-Opus catalog declares no samplerate', () => {
    expect(toAudioDecoderConfig(audioTrack({ codecs: ['mp4a.40.2'] }))).toBeNull();
  });

  it('pins Opus to 48 kHz without a declared samplerate (RFC 6716 decode rate)', () => {
    expect(toAudioDecoderConfig(audioTrack({ codecs: ['Opus'] }))).toMatchObject({ sampleRate: 48_000 });
  });
});
