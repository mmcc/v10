/**
 * LOC (Low Overhead Media Container, draft-ietf-moq-loc-04) frame
 * extraction.
 *
 * With LOC packaging each MOQT object carries exactly one encoded frame:
 * the object payload is the "internal data" of a WebCodecs
 * `EncodedVideoChunk`/`EncodedAudioChunk`, and the object properties carry
 * frame metadata (capture timestamp, timescale, decoder config).
 *
 * DOM-free and wire-free: properties come in as generic key/value pairs
 * (structurally identical to `network/moqt`'s `KeyValuePair` — the
 * layering keeps `media/` independent of `network/`, and structural
 * typing lets the playback layer pass them straight through).
 */

/** Structural twin of `network/moqt`'s `KeyValuePair`. */
export interface PropertyPair {
  type: number;
  value: number | Uint8Array;
}

/**
 * LOC property IDs from the MOQ Properties registry (loc-04 §6.1), which
 * settled the pre-IANA collisions of loc-02/03: 0x08 TIMESCALE (Track,
 * Object), 0x09 VIDEO_FRAME_MARKING (Object), 0x0C AUDIO_LEVEL (Object),
 * 0x0D VIDEO_CONFIG (Track, Object), 0x0F AUDIO_CONFIG (Track, Object),
 * 0x10 TIMESTAMP (Object). Even IDs carry varint values, odd IDs carry
 * length-prefixed bytes.
 *
 * Only the IDs SPF touches are named. AUDIO_CONFIG (0x0F) is emit-only:
 * `loc-packaging.ts` labels audio extradata with it for loc-04 consumers,
 * but this decode path never reads it — an audio decoder's `description`
 * comes from the catalog's initDataList, and `LocFrame` carries no
 * audio-config field to put it in.
 *
 * TIMESTAMP moved from 0x06 to 0x10 in loc-04. 0x06 stays accepted on
 * decode — deployed draft-03 publishers still emit it, and SPF only ever
 * reads LOC. 0x0A, draft-03's other Timestamp candidate, is NOT accepted:
 * loc-04 gives it to Secure Objects private properties (§3.1.3), so
 * reading it as a timestamp would misparse encrypted metadata.
 *
 * **The 0x06 branch is two lines and it is not dead weight — name what still
 * needs it before removing it.** One live publisher does: a moq-dev relay before
 * 0.14.6 re-emits Object Property timestamps as 0x06 (upstream moved the encoder
 * to 0x10 in `08224275`, released in 0.14.6, and kept 0x06 accepted on decode
 * indefinitely — so the two implementations are symmetric here rather than one
 * compensating for the other). SPF's own publisher (`loc-packaging.ts`) emitted
 * 0x06 as its primary until it moved to 0x10 with this table. When pre-0.14.6
 * relays have aged out of the fleet, this constant and its branch go together.
 */
export const LOC_PROPERTY = {
  TIMESTAMP: 0x10,
  /** draft-03 Timestamp, decode-only. Loses to 0x10 when both are present. */
  TIMESTAMP_DRAFT03: 0x06,
  TIMESCALE: 0x08,
  VIDEO_CONFIG: 0x0d,
  AUDIO_CONFIG: 0x0f,
} as const;

export const MICROSECONDS_PER_SECOND = 1_000_000;

export interface LocProperties {
  /** Frame timestamp in `timescale` units (absent: no timing metadata). */
  timestamp?: number;
  /** Timestamp units per second. Absent: microseconds since Unix epoch. */
  timescale?: number;
  /** Codec `extradata` — maps to WebCodecs `config.description`. */
  videoConfig?: Uint8Array;
}

export function parseLocProperties(properties: readonly PropertyPair[]): LocProperties {
  const parsed: LocProperties = {};
  let legacyTimestamp: number | undefined;
  for (const { type, value } of properties) {
    if (type === LOC_PROPERTY.TIMESTAMP && typeof value === 'number') parsed.timestamp = value;
    else if (type === LOC_PROPERTY.TIMESTAMP_DRAFT03 && typeof value === 'number') legacyTimestamp = value;
    else if (type === LOC_PROPERTY.TIMESCALE && typeof value === 'number') parsed.timescale = value;
    else if (type === LOC_PROPERTY.VIDEO_CONFIG && typeof value !== 'number') parsed.videoConfig = value;
  }
  // Applied after the loop, not in it: 0x10 wins over 0x06 in whichever
  // order a mixed-draft publisher emits them.
  if (parsed.timestamp === undefined && legacyTimestamp !== undefined) parsed.timestamp = legacyTimestamp;
  return parsed;
}

/**
 * The TIMESCALE (0x08) declared at *track* scope, from a SUBSCRIBE_OK's Track
 * Properties.
 *
 * Track Properties and Object Properties share one registry, so this is the same
 * code point `parseLocProperties` reads per object — the scope is the difference.
 * Reading it is not optional bookkeeping: a publisher states the units once per
 * track, and moq-dev relays from 0.14.6 (upstream `08224275`) stopped repeating
 * TIMESCALE on every object because restating a per-track constant costs bytes per
 * frame. So for those relays this is the *only* declaration on the wire, and a
 * reader without it silently falls back to microseconds — correct only while every
 * track happens to be microsecond-scaled, and wrong by a factor of 1000 on the
 * first track that is not.
 *
 * Returns `undefined` when no usable declaration is present, which includes a
 * zero: a timescale of zero would make every conversion a division by zero, and
 * treating it as absent lets the documented fallback chain handle it.
 */
export function parseTrackTimescale(properties: readonly PropertyPair[]): number | undefined {
  for (const { type, value } of properties) {
    if (type === LOC_PROPERTY.TIMESCALE && typeof value === 'number' && value > 0) return value;
  }
  return undefined;
}

/** One decodable frame extracted from a LOC-packaged MOQT object. */
export interface LocFrame {
  /** WebCodecs chunk timestamp in microseconds. */
  timestampUs: number;
  /**
   * Key frame flag. MSF maps one GOP per MOQT group (msf-01 §4.1), so the
   * group's first object is the random-access point.
   */
  isKey: boolean;
  /** Codec `extradata` carried alongside this frame, when present. */
  videoConfig?: Uint8Array;
  payload: Uint8Array;
}

export interface LocObjectLike {
  objectId: number;
  properties: readonly PropertyPair[];
  payload: Uint8Array;
}

export interface ToLocFrameOptions {
  /** Catalog-declared timescale (msf-01 §5.2.21) used when the object carries none. */
  timescale?: number;
}

/**
 * Convert a LOC timestamp to WebCodecs microseconds. Without any
 * timescale the value is already microseconds (loc-04 §2.3.1.1).
 */
export function locTimestampToMicroseconds(timestamp: number, timescale?: number): number {
  if (timescale === undefined || timescale === MICROSECONDS_PER_SECOND) return timestamp;
  return Math.round((timestamp / timescale) * MICROSECONDS_PER_SECOND);
}

/**
 * Extract the decodable frame from a LOC-packaged object. Returns `null`
 * for objects with no payload (status markers) or no usable timestamp.
 */
export function toLocFrame(object: LocObjectLike, options: ToLocFrameOptions = {}): LocFrame | null {
  if (object.payload.length === 0) return null;
  const properties = parseLocProperties(object.properties);
  if (properties.timestamp === undefined) return null;
  const timescale = properties.timescale ?? options.timescale;
  const frame: LocFrame = {
    timestampUs: locTimestampToMicroseconds(properties.timestamp, timescale),
    isKey: object.objectId === 0,
    payload: object.payload,
  };
  if (properties.videoConfig !== undefined) frame.videoConfig = properties.videoConfig;
  return frame;
}
