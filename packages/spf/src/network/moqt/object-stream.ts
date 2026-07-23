/**
 * MOQT unidirectional data-stream parsing (moq-transport draft-19 §3.4, §11).
 *
 * Every unidirectional stream begins with a varint stream type:
 *
 * - `SUBGROUP_HEADER` (0b0XX1XXXX) — objects for one subgroup of one group
 *   of a subscribed track, identified by Track Alias.
 * - `FETCH_HEADER` (0x05) — objects for a FETCH response, identified by
 *   Request ID.
 * - `SETUP` (0x2F00) — the peer's control stream (handled by the session).
 * - `PADDING` (0x132B3E28) — bandwidth probing; drained and ignored.
 *
 * The parsers are async generators over a `StreamReader`, mirroring how
 * `ChunkedStreamIterable` adapts fetch bodies elsewhere in `network/`.
 */
import { ByteReader, type StreamReader } from './bytes';
import { decodeKeyValuePairs, type KeyValuePair } from './control-messages';
import { MoqtProtocolError } from './errors';
import { MAX_VARINT_VALUE } from './varint';

// ============================================================================
// Stream types
// ============================================================================

export const STREAM_TYPE = {
  FETCH_HEADER: 0x05,
  SETUP: 0x2f00,
  PADDING: 0x132b3e28,
} as const;

/**
 * Whether a stream-type varint is a SUBGROUP_HEADER. Valid values have the
 * form 0b0XX1XXXX (bit 4 set, bit 7 clear) with SUBGROUP_ID_MODE ≠ 0b11
 * (reserved).
 */
export function isSubgroupHeaderType(type: number): boolean {
  if (type > 0x7f || (type & 0x10) === 0) return false;
  return (type & 0x06) >> 1 !== 0b11;
}

// ============================================================================
// Object model
// ============================================================================

export type ObjectStatus = 'normal' | 'end-of-group' | 'end-of-track';

const OBJECT_STATUS_WIRE: Record<number, ObjectStatus> = {
  0: 'normal',
  3: 'end-of-group',
  4: 'end-of-track',
};

/** An object delivered on a subscription's subgroup stream. */
export interface MoqtObject {
  groupId: number;
  objectId: number;
  subgroupId: number;
  /** Publisher priority; `undefined` inherits the subscription's priority. */
  priority?: number;
  status: ObjectStatus;
  properties: KeyValuePair[];
  payload: Uint8Array;
}

// ============================================================================
// Subgroup streams (§11.4.2)
// ============================================================================

const SUBGROUP_FLAG = {
  PROPERTIES: 0x01,
  SUBGROUP_ID_MODE_MASK: 0x06,
  END_OF_GROUP: 0x08,
  DEFAULT_PRIORITY: 0x20,
  FIRST_OBJECT: 0x40,
} as const;

export type SubgroupIdMode = 'zero' | 'first-object-id' | 'explicit';

export interface SubgroupHeader {
  type: number;
  trackAlias: number;
  groupId: number;
  subgroupIdMode: SubgroupIdMode;
  /** Present when `subgroupIdMode` is `'explicit'`. */
  subgroupId?: number;
  /** Present when the header carries an explicit priority. */
  priority?: number;
  /** All objects in this subgroup carry a Properties field. */
  hasProperties: boolean;
  /** This subgroup contains the largest object in the group (on FIN). */
  endOfGroup: boolean;
  /** The first object on this stream is the subgroup's first published object. */
  firstObject: boolean;
}

/** Read the SUBGROUP_HEADER fields (the stream-type varint must already be consumed). */
export async function readSubgroupHeader(reader: StreamReader, type: number): Promise<SubgroupHeader> {
  if (!isSubgroupHeaderType(type)) {
    throw new MoqtProtocolError(`invalid subgroup header type 0x${type.toString(16)}`);
  }
  const modeBits = (type & SUBGROUP_FLAG.SUBGROUP_ID_MODE_MASK) >> 1;
  const subgroupIdMode: SubgroupIdMode =
    modeBits === 0b00 ? 'zero' : modeBits === 0b01 ? 'first-object-id' : 'explicit';

  const trackAlias = await reader.readVarint();
  const groupId = await reader.readVarint();
  const subgroupId = subgroupIdMode === 'explicit' ? await reader.readVarint() : undefined;
  const priority = (type & SUBGROUP_FLAG.DEFAULT_PRIORITY) === 0 ? await reader.readUint8() : undefined;

  return {
    type,
    trackAlias,
    groupId,
    subgroupIdMode,
    subgroupId,
    priority,
    hasProperties: (type & SUBGROUP_FLAG.PROPERTIES) !== 0,
    endOfGroup: (type & SUBGROUP_FLAG.END_OF_GROUP) !== 0,
    firstObject: (type & SUBGROUP_FLAG.FIRST_OBJECT) !== 0,
  };
}

/** Object Properties structure (§11.2.1.2): varint length + Key-Value-Pairs. */
async function readObjectProperties(reader: StreamReader): Promise<KeyValuePair[]> {
  const length = await reader.readVarint();
  if (length === 0) return [];
  const bytes = await reader.readBytes(length);
  return decodeKeyValuePairs(new ByteReader(bytes), length);
}

function readObjectStatus(statusWire: number): ObjectStatus {
  const status = OBJECT_STATUS_WIRE[statusWire];
  if (status === undefined) throw new MoqtProtocolError(`unknown object status ${statusWire}`);
  return status;
}

/**
 * Yield the objects of one subgroup stream until FIN. Object IDs are
 * delta-decoded (`delta + 1` from the previous object; absolute for the
 * first). The stream's `subgroupId` resolves per the header's mode — for
 * `'first-object-id'` it is the first object's ID.
 */
export async function* readSubgroupObjects(reader: StreamReader, header: SubgroupHeader): AsyncGenerator<MoqtObject> {
  let previousObjectId: number | undefined;
  let subgroupId = header.subgroupIdMode === 'explicit' ? header.subgroupId! : 0;

  while (!(await reader.atEnd())) {
    const objectIdDelta = await reader.readVarint();
    const objectId = previousObjectId === undefined ? objectIdDelta : previousObjectId + objectIdDelta + 1;
    // Each operand fits the varint range, but the delta sum can round past
    // 2^53-1 and silently collide subsequent IDs — the exact corruption the
    // varint layer rejects loudly.
    if (objectId > MAX_VARINT_VALUE) {
      throw new MoqtProtocolError('subgroup object ID exceeds supported range');
    }
    if (previousObjectId === undefined && header.subgroupIdMode === 'first-object-id') {
      subgroupId = objectId;
    }
    previousObjectId = objectId;

    const properties = header.hasProperties ? await readObjectProperties(reader) : [];
    const payloadLength = await reader.readVarint();
    const status = payloadLength === 0 ? readObjectStatus(await reader.readVarint()) : 'normal';
    const payload = payloadLength > 0 ? await reader.readBytes(payloadLength) : new Uint8Array(0);

    yield {
      groupId: header.groupId,
      objectId,
      subgroupId,
      priority: header.priority,
      status,
      properties,
      payload,
    };
  }
}

// ============================================================================
// Fetch streams (§11.4.4)
// ============================================================================

const FETCH_FLAG = {
  SUBGROUP_MODE_MASK: 0x03,
  OBJECT_ID_DELTA_PRESENT: 0x04,
  GROUP_ID_DELTA_PRESENT: 0x08,
  PRIORITY_PRESENT: 0x10,
  PROPERTIES_PRESENT: 0x20,
  DATAGRAM: 0x40,
} as const;

const FETCH_END_OF_NON_EXISTENT_RANGE = 0x8c;
const FETCH_END_OF_UNKNOWN_RANGE = 0x10c;

export type FetchStreamEntry =
  | {
      kind: 'object';
      groupId: number;
      objectId: number;
      /** Absent for objects with Forwarding Preference = Datagram. */
      subgroupId?: number;
      priority: number;
      properties: KeyValuePair[];
      payload: Uint8Array;
    }
  | {
      kind: 'end-of-range';
      status: 'non-existent' | 'unknown';
      groupId: number;
      objectId: number;
    };

/** Read the FETCH_HEADER's Request ID (the stream-type varint must already be consumed). */
export async function readFetchHeader(reader: StreamReader): Promise<{ requestId: number }> {
  return { requestId: await reader.readVarint() };
}

/**
 * Yield the entries of one FETCH response stream until FIN. Group/object
 * IDs are delta-decoded against the prior entry per §11.4.4.1; the first
 * object must carry both deltas (as absolute values).
 */
export async function* readFetchEntries(
  reader: StreamReader,
  groupOrder: 'ascending' | 'descending' = 'ascending'
): AsyncGenerator<FetchStreamEntry> {
  let prior: { groupId: number; objectId: number; subgroupId?: number; priority?: number } | undefined;

  while (!(await reader.atEnd())) {
    const flags = await reader.readVarint();

    if (flags === FETCH_END_OF_NON_EXISTENT_RANGE || flags === FETCH_END_OF_UNKNOWN_RANGE) {
      const groupId = await reader.readVarint();
      const objectId = await reader.readVarint();
      const status = flags === FETCH_END_OF_NON_EXISTENT_RANGE ? 'non-existent' : 'unknown';
      // The indicator becomes the prior Location; subgroup/priority carry
      // over from the last actual object (§11.4.4.2).
      prior = { groupId, objectId, subgroupId: prior?.subgroupId, priority: prior?.priority };
      yield { kind: 'end-of-range', status, groupId, objectId };
      continue;
    }
    if (flags > 0x7f) {
      throw new MoqtProtocolError(`invalid fetch serialization flags 0x${flags.toString(16)}`);
    }

    const groupIdDeltaPresent = (flags & FETCH_FLAG.GROUP_ID_DELTA_PRESENT) !== 0;
    const objectIdDeltaPresent = (flags & FETCH_FLAG.OBJECT_ID_DELTA_PRESENT) !== 0;
    if (prior === undefined && (!groupIdDeltaPresent || !objectIdDeltaPresent)) {
      throw new MoqtProtocolError('first fetch object must carry group and object IDs');
    }

    const groupIdDelta = groupIdDeltaPresent ? await reader.readVarint() : undefined;

    // Subgroup encoding: 2 LSBs, ignored when the DATAGRAM bit is set.
    const isDatagram = (flags & FETCH_FLAG.DATAGRAM) !== 0;
    const subgroupMode = isDatagram ? -1 : flags & FETCH_FLAG.SUBGROUP_MODE_MASK;
    let subgroupId: number | undefined;
    if (subgroupMode === 0x03) {
      subgroupId = await reader.readVarint();
    } else if (subgroupMode === 0x00) {
      subgroupId = 0;
    } else if (subgroupMode === 0x01 || subgroupMode === 0x02) {
      if (prior?.subgroupId === undefined) {
        throw new MoqtProtocolError('fetch object references prior subgroup ID with no prior object');
      }
      subgroupId = subgroupMode === 0x01 ? prior.subgroupId : prior.subgroupId + 1;
    }

    const objectIdDelta = objectIdDeltaPresent ? await reader.readVarint() : undefined;

    const groupId =
      groupIdDelta === undefined
        ? prior!.groupId
        : prior === undefined
          ? groupIdDelta
          : groupOrder === 'ascending'
            ? prior.groupId + groupIdDelta + 1
            : prior.groupId - (groupIdDelta + 1);
    if (groupId < 0) throw new MoqtProtocolError('fetch group ID underflow');

    const objectId =
      prior === undefined
        ? objectIdDelta!
        : groupIdDelta !== undefined
          ? (objectIdDelta ?? prior.objectId + 1)
          : objectIdDelta !== undefined
            ? prior.objectId + objectIdDelta
            : prior.objectId + 1;
    // Mirror of the underflow check above: delta sums can round past 2^53-1
    // and silently collapse later locations.
    if (groupId > MAX_VARINT_VALUE || objectId > MAX_VARINT_VALUE) {
      throw new MoqtProtocolError('fetch location exceeds supported range');
    }

    let priority: number;
    if ((flags & FETCH_FLAG.PRIORITY_PRESENT) !== 0) {
      priority = await reader.readUint8();
    } else {
      if (prior?.priority === undefined) {
        throw new MoqtProtocolError('fetch object references prior priority with no prior object');
      }
      priority = prior.priority;
    }

    const properties = (flags & FETCH_FLAG.PROPERTIES_PRESENT) !== 0 ? await readObjectProperties(reader) : [];
    const payloadLength = await reader.readVarint();
    const payload = payloadLength > 0 ? await reader.readBytes(payloadLength) : new Uint8Array(0);

    prior = { groupId, objectId, subgroupId: subgroupId ?? prior?.subgroupId, priority };
    yield { kind: 'object', groupId, objectId, subgroupId, priority, properties, payload };
  }
}
