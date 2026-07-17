/**
 * Catalog codec strings → WebCodecs decoder configs (msf-01 §5.2.18: LOC
 * codec strings are WebCodecs Codec Registry strings, so the mapping is
 * mostly a projection of catalog fields onto config fields).
 *
 * The WebCodecs types come from the WebWorker lib — this stays DOM-free.
 */
import type { MoqAudioTrack, MoqVideoTrack } from './parse-catalog';

/**
 * Decoder config for a catalog video track, or `null` when the catalog
 * carries no codec for it (undecodable as published).
 *
 * `description` (codec extradata) prefers the catalog's init data; LOC
 * tracks that ship parameter sets per-keyframe instead carry them in the
 * Video Config property or in-band, so its absence is normal.
 */
export function toVideoDecoderConfig(track: MoqVideoTrack): VideoDecoderConfig | null {
  const codec = track.codecs[0];
  if (!codec) return null;
  const config: VideoDecoderConfig = { codec };
  if (track.width !== undefined) config.codedWidth = track.width;
  if (track.height !== undefined) config.codedHeight = track.height;
  if (track.moq.initData !== undefined) {
    // BufferSource copy: description must not alias a live buffer.
    config.description = track.moq.initData.slice().buffer;
  }
  return config;
}

/** Decoder config for a catalog audio track, or `null` without a codec. */
export function toAudioDecoderConfig(track: MoqAudioTrack): AudioDecoderConfig | null {
  const codec = track.codecs[0];
  if (!codec) return null;
  const config: AudioDecoderConfig = {
    codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
  };
  if (track.moq.initData !== undefined) {
    config.description = track.moq.initData.slice().buffer;
  }
  return config;
}
