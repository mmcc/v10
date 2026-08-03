/**
 * LOC (Low Overhead Media Container, draft-ietf-moq-loc-04) frame
 * packaging — the encode-direction complement to `loc.ts` extraction.
 *
 * Each encoded WebCodecs chunk becomes one MOQT object: the chunk bytes
 * are the object payload and the frame metadata rides as object
 * properties, under the loc-04 registry pins in `LOC_PROPERTY`
 * (Timestamp / Timescale / Video Config / Audio Config). A packaged
 * video frame always round-trips through `toLocFrame`; a packaged audio
 * config does not — AUDIO_CONFIG is emitted for loc-04 consumers, but
 * SPF's own extraction never reads it (see the `LOC_PROPERTY` doc).
 *
 * DOM-free and wire-free: the chunk comes in structurally (no WebCodecs
 * lib dependency) and properties go out as the same generic key/value
 * pairs `loc.ts` consumes.
 */

import { LOC_PROPERTY, MICROSECONDS_PER_SECOND, type PropertyPair } from './loc';

/**
 * Structural view of a WebCodecs `EncodedVideoChunk` / `EncodedAudioChunk`
 * — just the members packaging needs, so this module stays DOM-free and
 * tests can feed plain objects.
 */
export interface EncodedChunkLike {
  /** `'key'` for independently decodable chunks, `'delta'` otherwise. */
  type: 'key' | 'delta';
  /** WebCodecs chunk timestamp — microseconds. */
  timestamp: number;
  byteLength: number;
  copyTo(destination: Uint8Array): void;
}

export interface PackageLocFrameMeta {
  /**
   * Codec `extradata` (WebCodecs `decoderConfig.description`) to carry
   * beside independently decodable chunks, e.g. avcC for `avc`-format
   * H.264. Carried in the LOC Video Config property on `'key'` chunks
   * only — the subscribe side (`video-renderer`) applies it as the
   * decoder `description` when a keyframe arrives.
   */
  videoConfig?: Uint8Array;
  /**
   * Codec `extradata` for audio, e.g. AAC AudioSpecificConfig — Opus
   * carries none. Carried in the LOC Audio Config property on `'key'`
   * chunks; audio chunks are all `'key'` (every audio frame starts its
   * own MOQT group), so a declared audio config rides every frame.
   */
  audioConfig?: Uint8Array;
  /**
   * Timestamp units per second to declare on the wire. Defaults to
   * microseconds — WebCodecs' native unit — declared explicitly so
   * receivers never fall back to loc-04's absent-timescale epoch
   * semantics for capture-relative timestamps.
   */
  timescale?: number;
}

/** One encoded frame packaged as MOQT object payload + properties. */
export interface PackagedLocFrame {
  payload: Uint8Array;
  properties: PropertyPair[];
}

/**
 * Convert a WebCodecs microsecond timestamp to LOC timestamp units —
 * the inverse of `locTimestampToMicroseconds`.
 */
export function microsecondsToLocTimestamp(timestampUs: number, timescale?: number): number {
  if (timescale === undefined || timescale === MICROSECONDS_PER_SECOND) return timestampUs;
  return Math.round((timestampUs / MICROSECONDS_PER_SECOND) * timescale);
}

/**
 * Package one encoded chunk as a LOC MOQT object body: the chunk bytes
 * as the payload plus Timestamp, Timescale, and (for `'key'` chunks with
 * a declared config) the matching Config property.
 *
 * Group/object numbering is the track publisher's concern — MSF maps one
 * GOP per MOQT group, so the publisher starts a new group at each `'key'`
 * chunk and the extraction side recovers the keyframe flag from
 * `objectId === 0`.
 */
export function packageLocFrame(chunk: EncodedChunkLike, meta: PackageLocFrameMeta = {}): PackagedLocFrame {
  const timescale = meta.timescale ?? MICROSECONDS_PER_SECOND;
  const payload = new Uint8Array(chunk.byteLength);
  chunk.copyTo(payload);

  const properties: PropertyPair[] = [
    { type: LOC_PROPERTY.TIMESTAMP, value: microsecondsToLocTimestamp(chunk.timestamp, timescale) },
    { type: LOC_PROPERTY.TIMESCALE, value: timescale },
  ];
  if (chunk.type === 'key') {
    if (meta.videoConfig !== undefined) properties.push({ type: LOC_PROPERTY.VIDEO_CONFIG, value: meta.videoConfig });
    if (meta.audioConfig !== undefined) properties.push({ type: LOC_PROPERTY.AUDIO_CONFIG, value: meta.audioConfig });
  }
  return { payload, properties };
}
