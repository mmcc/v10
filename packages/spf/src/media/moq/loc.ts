/**
 * LOC (Low Overhead Media Container, draft-ietf-moq-loc-02) frame
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
 * LOC property IDs from the MOQ Properties registry (loc-02 §2.3).
 * Even IDs carry varint values, odd IDs carry length-prefixed bytes.
 * Note: loc-02's pre-IANA Video Frame Marking (4) and Audio Level (6)
 * assignments collide with Timestamp (0x06); until the registry settles
 * (a Phase 0 interop pin), only Timestamp/Timescale/Video Config are
 * interpreted.
 */
export const LOC_PROPERTY = {
  TIMESTAMP: 0x06,
  TIMESCALE: 0x08,
  VIDEO_CONFIG: 13,
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
  for (const { type, value } of properties) {
    if (type === LOC_PROPERTY.TIMESTAMP && typeof value === 'number') parsed.timestamp = value;
    else if (type === LOC_PROPERTY.TIMESCALE && typeof value === 'number') parsed.timescale = value;
    else if (type === LOC_PROPERTY.VIDEO_CONFIG && typeof value !== 'number') parsed.videoConfig = value;
  }
  return parsed;
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
 * timescale the value is already microseconds (loc-02 §2.3.1.1).
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
