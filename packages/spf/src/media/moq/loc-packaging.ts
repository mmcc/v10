/**
 * LOC (Low Overhead Media Container, draft-ietf-moq-loc-02) frame
 * packaging — the encode-direction complement to `loc.ts` extraction.
 *
 * Each encoded WebCodecs chunk becomes one MOQT object: the chunk bytes
 * are the object payload and the frame metadata rides as object
 * properties. Only the properties `loc.ts` interprets are produced
 * (Timestamp / Timescale / Config per its loc-02 registry pins), so a
 * packaged frame always round-trips through `toLocFrame`.
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
   * H.264. Carried in the LOC Config property on `'key'` chunks only —
   * the subscribe side (`video-renderer`) applies it as the decoder
   * `description` when a keyframe arrives. Audio chunks are all `'key'`
   * (every audio frame starts its own MOQT group), so an audio config
   * rides every frame; codecs with no extradata (Opus) simply omit it.
   */
  config?: Uint8Array;
  /**
   * Timestamp units per second to declare on the wire. Defaults to
   * microseconds — WebCodecs' native unit — declared explicitly so
   * receivers never fall back to loc-02's absent-timescale epoch
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
 * Package one encoded chunk as a LOC MOQT object body. Produces exactly
 * what `toLocFrame` extraction consumes: the chunk bytes as the payload
 * plus Timestamp, Timescale, and (for `'key'` chunks with a `config`)
 * the Config property.
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
  if (meta.config !== undefined && chunk.type === 'key') {
    properties.push({ type: LOC_PROPERTY.VIDEO_CONFIG, value: meta.config });
  }
  return { payload, properties };
}
