/**
 * Loopback MoQ relay for the publisher sandbox — an in-page relay that sits between the real publish engine and the
 * real playback engine.
 *
 * One side accepts a `MoqPublishMedia` session through its `connectTransport` seam and plays the relay half of
 * announce-and-serve, mirroring moq-relay 0.14.7's pull-through ingest: it answers the SETUP exchange, solicits
 * announces with a SUBSCRIBE_NAMESPACE for the empty prefix, and — as the in-page player side asks for tracks (catalog
 * first, then the catalog's tracks) — opens one upstream SUBSCRIBE per track, routing the publisher's subgroup data
 * streams by the SUBSCRIBE_OK-returned aliases into per-track object buffers (a small ring of the most recent groups).
 * Pull-through works in both directions: when the last player interest in a track leaves, the upstream subscription is
 * FINed (the clean unsubscribe — the publisher unbinds and stops sending), and a later subscribe pulls the track afresh
 * with a new request ID; a publisher-side FIN is the end of the track and is propagated to every attached viewer as
 * their own clean stream end. A proactive PUBLISH from an old client is refused with a request error, exactly like the
 * real relay. The other side serves `MoqMediaMixin` player sessions through their `createMoqTransport` seam exactly
 * like `spf-moq-player`'s loopback: SETUP, SUBSCRIBE answered with SUBSCRIBE_OK, FETCH rejected (no history), and
 * objects forwarded one-per-stream — replaying the newest buffered group on subscribe (a keyframe opens every video
 * group, so joining is instant) and live-forwarding from there. Multiple sequential player sessions re-serve the latest
 * catalog.
 *
 * The wire encoding is written from the specs rather than reusing `network/moqt`'s codecs (they are not public API);
 * the byte-level shapes mirror `spf-moq-player/loopback-relay.ts`, extended with the publisher-facing decoders
 * (draft-ietf-moq-transport-19 §10, §11.4.2). If this grows further, the pieces worth exporting properly from
 * `@videojs/spf` are the control-message codec and a transport-pair helper.
 */
import type { CreateMoqTransport } from '@videojs/spf/moq';
import type { ConnectPublishTransport } from '@videojs/spf/moq-publish';

// ============================================================================
// Wire primitives (draft-ietf-moq-transport-19)
// ============================================================================

/** Control/request message types (§10, Table 5). */
const MESSAGE_TYPE = {
  SETUP: 0x2f00,
  SUBSCRIBE: 0x3,
  SUBSCRIBE_OK: 0x4,
  REQUEST_ERROR: 0x5,
  REQUEST_OK: 0x7,
  NAMESPACE: 0x8,
  NAMESPACE_DONE: 0xe,
  FETCH: 0x16,
  PUBLISH: 0x1d,
  SUBSCRIBE_NAMESPACE: 0x50,
} as const;

/** REQUEST_ERROR code for "nothing published in that range" (§10.6.1). */
const ERROR_INVALID_RANGE = 0x11;

/** REQUEST_ERROR code moq-relay 0.14.7 answers proactive PUBLISH with. */
const ERROR_PUBLISH_NOT_SUPPORTED = 400;

/** REQUEST_ERROR code for an unregistered track (§15.11.2). */
const ERROR_DOES_NOT_EXIST = 0x10;

/**
 * How long an upstream pull for a not-yet-registered track waits before retrying while a player still wants it. The
 * real relay hub polls its registry every 25ms while demand stands; the loopback keeps the same order of magnitude with
 * less request-stream churn.
 */
const UPSTREAM_RETRY_DELAY_MS = 50;

/** Message parameter types the upstream SUBSCRIBE carries (§10.2). */
const SUBSCRIBE_PARAMETER = {
  FORWARD: 0x10,
  SUBSCRIBER_PRIORITY: 0x20,
  LOCATION_FILTER: 0x21,
  GROUP_ORDER: 0x22,
} as const;

/** Location Filter type "largest-object" (§5.1.2) — join at the live edge. */
const LOCATION_FILTER_LARGEST_OBJECT = 0x2;

/** GROUP_ORDER wire value for descending delivery (§10.2). */
const GROUP_ORDER_DESCENDING = 0x2;

/** Track Property carrying the track's timestamp units-per-second (§10.8). */
const TRACK_PROPERTY_TIMESCALE = 0x08;

/**
 * SUBGROUP_HEADER stream type used toward the _player_: subgroup-id mode `zero`, default publisher priority, objects
 * carry a Properties field — `0b0011_0001` (§11.4.2), the same shape `spf-moq-player`'s loopback publishes and the
 * engine demonstrably consumes.
 */
const PLAYER_SUBGROUP_HEADER_TYPE = 0x31;

/** SUBGROUP_HEADER type-flag bits (§11.4.2) for parsing the publisher side. */
const SUBGROUP_FLAG = {
  PROPERTIES: 0x01,
  SUBGROUP_ID_MODE_MASK: 0x06,
  DEFAULT_PRIORITY: 0x20,
} as const;

const STREAM_TYPE_PADDING = 0x132b3e28;

/** 0b0XX1XXXX with SUBGROUP_ID_MODE ≠ 0b11 (reserved). */
function isSubgroupHeaderType(type: number): boolean {
  if (type > 0x7f || (type & 0x10) === 0) return false;

  return (type & SUBGROUP_FLAG.SUBGROUP_ID_MODE_MASK) >> 1 !== 0b11;
}

/**
 * The vi64 varint of draft-15+ (§1.4.1) — leading ones on the first byte give the encoded length minus one, so an
 * L-byte encoding carries 7L value bits. NOT the QUIC RFC 9000 varint.
 */
function varintByteLength(value: number): number {
  for (let length = 1; length < 8; length++) {
    if (value < 2 ** (7 * length)) return length;
  }

  return 8;
}

class Writer {
  #bytes: number[] = [];

  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  varint(value: number): this {
    const length = varintByteLength(value);
    const tail: number[] = [];
    let remaining = value;

    for (let i = length - 1; i >= 1; i--) {
      tail[i - 1] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }

    const prefix = length === 1 ? 0 : (0xff << (9 - length)) & 0xff;

    this.u8(prefix | remaining);

    for (const byte of tail) this.u8(byte);

    return this;
  }

  bytes(source: Uint8Array): this {
    for (const byte of source) this.#bytes.push(byte);

    return this;
  }

  /** Varint length prefix + payload — the shape of names, blocks, and values. */
  lengthPrefixed(source: Uint8Array): this {
    return this.varint(source.length).bytes(source);
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

class Reader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  varint(): number {
    const first = this.bytes[this.#offset];
    if (first === undefined) throw new Error('varint: out of bounds');

    let length = 1;
    let mask = 0x80;

    while (length <= 8 && (first & mask) !== 0) {
      length++;
      mask >>= 1;
    }

    let value = length <= 8 ? first & (0xff >> length) : 0;

    for (let i = 1; i < length; i++) value = value * 256 + this.bytes[this.#offset + i]!;

    this.#offset += length;
    return value;
  }

  slice(length: number): Uint8Array {
    const slice = this.bytes.subarray(this.#offset, this.#offset + length);

    this.#offset += length;
    return slice;
  }

  /** Varint-length-prefixed UTF-8 string. */
  string(): string {
    return new TextDecoder().decode(this.slice(this.varint()));
  }
}

/**
 * Pull-based reader over a byte stream, for the publisher's long-lived subgroup streams (a group's objects trickle in
 * until FIN at the next keyframe). Minimal mirror of `network/moqt`'s `StreamReader`.
 */
class StreamByteReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = new Uint8Array(0);
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Buffer until `length` bytes are available; false on EOF first. */
  async #ensure(length: number): Promise<boolean> {
    while (this.#buffer.length < length) {
      if (this.#done) return false;

      const { value, done } = await this.#reader.read();

      if (done) {
        this.#done = true;
        return this.#buffer.length >= length;
      }

      const merged = new Uint8Array(this.#buffer.length + value.length);

      merged.set(this.#buffer);
      merged.set(value, this.#buffer.length);
      this.#buffer = merged;
    }

    return true;
  }

  async atEnd(): Promise<boolean> {
    return !(await this.#ensure(1));
  }

  async readUint8(): Promise<number> {
    if (!(await this.#ensure(1))) throw new Error('unexpected end of stream');

    const byte = this.#buffer[0]!;

    this.#buffer = this.#buffer.subarray(1);
    return byte;
  }

  async readVarint(): Promise<number> {
    if (!(await this.#ensure(1))) throw new Error('unexpected end of stream');

    const first = this.#buffer[0]!;
    let length = 1;
    let mask = 0x80;

    while (length <= 8 && (first & mask) !== 0) {
      length++;
      mask >>= 1;
    }

    if (!(await this.#ensure(length))) throw new Error('unexpected end of stream');

    let value = length <= 8 ? first & (0xff >> length) : 0;

    for (let i = 1; i < length; i++) value = value * 256 + this.#buffer[i]!;

    this.#buffer = this.#buffer.subarray(length);
    return value;
  }

  async readBytes(length: number): Promise<Uint8Array> {
    if (!(await this.#ensure(length))) throw new Error('unexpected end of stream');

    // Copy out — the backing buffer is re-sliced as parsing advances.
    const bytes = this.#buffer.slice(0, length);

    this.#buffer = this.#buffer.subarray(length);
    return bytes;
  }

  cancel(): void {
    void this.#reader.cancel().catch(() => {});
  }
}

/** Control message framing (§10.1): type varint + 16-bit length + body. */
function frame(type: number, body: Uint8Array): Uint8Array {
  return new Writer().varint(type).u16(body.length).bytes(body).toBytes();
}

/** Read one framed control message (§10.1) off a pull-based stream reader. */
async function readControlFrame(reader: StreamByteReader): Promise<{ type: number; body: Uint8Array }> {
  const type = await reader.readVarint();
  const high = await reader.readUint8();
  const low = await reader.readUint8();

  return { type, body: await reader.readBytes(high * 256 + low) };
}

/** Namespace tuple (§10.7): varint field count + length-prefixed UTF-8 fields. */
function writeNamespaceTuple(writer: Writer, namespace: string[]): Writer {
  writer.varint(namespace.length);

  for (const field of namespace) writer.lengthPrefixed(new TextEncoder().encode(field));

  return writer;
}

function readNamespaceTuple(reader: Reader): string[] {
  const count = reader.varint();
  const namespace: string[] = [];

  for (let i = 0; i < count; i++) namespace.push(reader.string());

  return namespace;
}

function encodeSetup(): Uint8Array {
  // Options-only, and we send none. A Key-Value-Pair block is bounded by its
  // enclosing length rather than counted (§10.2), so "no options" is an empty
  // body — not a zero count.
  return frame(MESSAGE_TYPE.SETUP, new Uint8Array(0));
}

function encodeSubscribeOk(trackAlias: number): Uint8Array {
  // Track Alias + message parameters (count-prefixed, so 0) + track
  // properties (a length-bounded KVP block, so nothing).
  return frame(MESSAGE_TYPE.SUBSCRIBE_OK, new Writer().varint(trackAlias).varint(0).toBytes());
}

/**
 * SUBSCRIBE_NAMESPACE toward the publisher (§10.18): the empty prefix solicits every namespace the publisher will
 * announce — the same solicitation moq-relay 0.14.7 opens right after SETUP.
 */
function encodeSubscribeNamespace(requestId: number): Uint8Array {
  // Request ID + namespace prefix tuple (count 0) + parameters (count 0).
  return frame(MESSAGE_TYPE.SUBSCRIBE_NAMESPACE, new Writer().varint(requestId).varint(0).varint(0).toBytes());
}

/**
 * SUBSCRIBE toward the publisher (§10.7) — the exact request moq-relay 0.14.7 sends when pulling a track: forward on,
 * subscriber priority 0, join at the largest object, descending group order. Message parameters are count-prefixed with
 * delta-encoded types and per-type value encodings (§10.2), so the byte after each delta is what that type says it is —
 * a raw uint8 for FORWARD / SUBSCRIBER_PRIORITY / GROUP_ORDER, a length-prefixed filter for LOCATION_FILTER.
 */
function encodeSubscribe(requestId: number, namespace: string[], trackName: string): Uint8Array {
  const body = new Writer().varint(requestId);

  writeNamespaceTuple(body, namespace);
  body.lengthPrefixed(new TextEncoder().encode(trackName));
  body.varint(4);
  body.varint(SUBSCRIBE_PARAMETER.FORWARD).u8(1);
  body.varint(SUBSCRIBE_PARAMETER.SUBSCRIBER_PRIORITY - SUBSCRIBE_PARAMETER.FORWARD).u8(0);
  body
    .varint(SUBSCRIBE_PARAMETER.LOCATION_FILTER - SUBSCRIBE_PARAMETER.SUBSCRIBER_PRIORITY)
    .varint(1)
    .varint(LOCATION_FILTER_LARGEST_OBJECT);
  body.varint(SUBSCRIBE_PARAMETER.GROUP_ORDER - SUBSCRIBE_PARAMETER.LOCATION_FILTER).u8(GROUP_ORDER_DESCENDING);
  return frame(MESSAGE_TYPE.SUBSCRIBE, body.toBytes());
}

function encodeRequestError(errorCode: number, reason: string): Uint8Array {
  const body = new Writer().varint(errorCode).varint(0).lengthPrefixed(new TextEncoder().encode(reason));

  return frame(MESSAGE_TYPE.REQUEST_ERROR, body.toBytes());
}

/**
 * One forwarded object on its own subgroup stream toward a player. The publisher's Object Properties block (LOC
 * timestamp et al) rides through verbatim as `properties`.
 */
function encodeObjectStream(
  trackAlias: number,
  groupId: number,
  objectId: number,
  properties: Uint8Array,
  payload: Uint8Array
): Uint8Array {
  const writer = new Writer()
    .varint(PLAYER_SUBGROUP_HEADER_TYPE)
    .varint(trackAlias)
    .varint(groupId)
    .varint(objectId)
    .lengthPrefixed(properties)
    .varint(payload.length);

  // A zero-length payload carries an Object Status varint instead (§11.2.1.1).
  return (payload.length === 0 ? writer.varint(0) : writer.bytes(payload)).toBytes();
}

// ============================================================================
// Track buffers
// ============================================================================

/** Recent groups retained per track — enough to replay the current GOP. */
const MAX_BUFFERED_GROUPS = 2;

interface BufferedObject {
  groupId: number;
  objectId: number;
  /** Raw Object Properties KVP block (unprefixed), forwarded verbatim. */
  properties: Uint8Array;
  payload: Uint8Array;
}

interface PlayerSubscription {
  trackAlias: number;
  deliver(object: BufferedObject): void;
  /**
   * End this subscription from the relay side: FIN toward the player and cancel its request stream, so its teardown
   * removes the entry. Used when the upstream track is aborted for every viewer.
   */
  end(): void;
}

interface TrackBuffer {
  name: string;
  /** Insertion-ordered groupId → objects; pruned to `MAX_BUFFERED_GROUPS`. */
  groups: Map<number, BufferedObject[]>;
  subscribers: Set<PlayerSubscription>;
  /**
   * The publisher FINed the upstream subscription: the track is done, not late, so DOES_NOT_EXIST answering a later
   * pull is terminal rather than a reason to poll. Cleared by a fresh SUBSCRIBE_OK (the publisher re-registered the
   * name) or a new publisher session.
   */
  ended: boolean;
}

// ============================================================================
// Relay
// ============================================================================

export interface PublisherLoopbackRelayStats {
  publisherState: 'none' | 'connected' | 'closed';
  /** Track names the relay holds a live upstream subscription for. */
  publishedTracks: string[];
  /** Player-subscribed track names, in subscribe order. */
  subscriptions: string[];
  objectsReceived: number;
  objectsForwarded: number;
  bytesReceived: number;
}

export interface PublisherLoopbackRelay {
  /** Transport seam for `MoqPublishMedia`'s `engineConfig.connectTransport`. */
  connectPublisher: ConnectPublishTransport;
  /** Transport seam for the player's `engineConfig.createMoqTransport`. */
  createMoqTransport: CreateMoqTransport;
  /** MSF URL a player resolves against this relay. */
  src: string;
  stats: PublisherLoopbackRelayStats;
  destroy(): void;
}

export interface PublisherLoopbackRelayOptions {
  onLog?: (message: string) => void;
}

/** The namespace + catalog track name the exposed `src` points at. */
const NAMESPACE = 'loopback';
const CATALOG_TRACK = 'catalog';

export function createPublisherLoopbackRelay({ onLog }: PublisherLoopbackRelayOptions = {}): PublisherLoopbackRelay {
  const log = (message: string) => onLog?.(message);
  const stats: PublisherLoopbackRelayStats = {
    publisherState: 'none',
    publishedTracks: [],
    subscriptions: [],
    objectsReceived: 0,
    objectsForwarded: 0,
    bytesReceived: 0,
  };

  let destroyed = false;
  let nextPlayerTrackAlias = 1;

  /** Tracks persist across publisher sessions; buffers reset per session. */
  const tracks = new Map<string, TrackBuffer>();

  /** One entry per live transport (either side), so `destroy()` releases all. */
  const closeTransports = new Set<() => void>();

  const trackFor = (name: string): TrackBuffer => {
    let track = tracks.get(name);

    if (!track) {
      track = { name, groups: new Map(), subscribers: new Set(), ended: false };
      tracks.set(name, track);
    }

    return track;
  };

  /** Ring-buffer the object, then fan it out to the track's live subscribers. */
  const bufferAndForward = (track: TrackBuffer, object: BufferedObject): void => {
    let group = track.groups.get(object.groupId);

    if (!group) {
      group = [];
      track.groups.set(object.groupId, group);

      while (track.groups.size > MAX_BUFFERED_GROUPS) {
        const oldest = track.groups.keys().next().value!;

        track.groups.delete(oldest);
      }
    }

    group.push(object);
    stats.objectsReceived++;
    stats.bytesReceived += object.payload.length;

    for (const subscriber of track.subscribers) subscriber.deliver(object);
  };

  /**
   * Replay the newest buffered group so a joining player starts decoding immediately: every group opens with a
   * random-access object (video keyframe / opus packet / whole catalog).
   */
  const replayNewestGroup = (track: TrackBuffer, subscriber: PlayerSubscription): void => {
    let newest: BufferedObject[] | undefined;
    let newestId = -1;

    for (const [groupId, objects] of track.groups) {
      if (groupId > newestId) {
        newestId = groupId;
        newest = objects;
      }
    }

    for (const object of newest ?? []) subscriber.deliver(object);
  };

  // ==========================================================================
  // Publisher side — solicits announces, subscribes on player interest
  // ==========================================================================

  /**
   * The live publisher session's "pull this track upstream" entry point, set while a publisher transport is connected.
   * Announce-and-serve means player interest is what makes data flow, so the player side calls this on every SUBSCRIBE
   * it accepts.
   */
  let requestUpstreamTrack: ((track: TrackBuffer) => void) | undefined;

  /**
   * Its counterpart: withdraws the upstream subscription when the last player interest in a track leaves, so the
   * publisher unbinds and stops encoding bytes into a track nobody watches.
   */
  let releaseUpstreamTrack: ((track: TrackBuffer) => void) | undefined;

  const connectPublisher: ConnectPublishTransport = (endpoint) => {
    // Per-session state, so a re-publish starts clean (fresh aliases, and
    // group IDs that restart at 0 must not merge into stale buffers).
    const aliasToTrack = new Map<number, TrackBuffer>();

    for (const track of tracks.values()) {
      track.groups.clear();
      track.ended = false;
    }

    stats.publishedTracks = [];
    stats.publisherState = 'connected';

    let sessionOpen = true;
    let uniController: ReadableStreamDefaultController<ReadableStream<Uint8Array>> | undefined;
    let bidiController:
      | ReadableStreamDefaultController<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>
      | undefined;
    let controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const openReaders = new Set<StreamByteReader>();
    /** Writers of relay-initiated request streams, aborted on close. */
    const requestWriters = new Set<WritableStreamDefaultWriter<Uint8Array>>();
    /** Pending DOES_NOT_EXIST retries, cleared on close. */
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();

    /** Request IDs are odd — the server-side numbering; SUBSCRIBE_NAMESPACE takes 1. */
    let nextRequestId = 1;
    const takeRequestId = (): number => {
      const requestId = nextRequestId;

      nextRequestId += 2;
      return requestId;
    };

    /** From the publisher's NAMESPACE entry — upstream SUBSCRIBEs name it. */
    let announcedNamespace: string[] | undefined;
    /**
     * Live upstream subscriptions, at most one per track, keyed on the live handle: `release()` FINs the request stream
     * (the clean unsubscribe), and the entry leaves the map as the routine unwinds — so a later player subscribe opens
     * a fresh SUBSCRIBE.
     */
    const upstreamByTrack = new Map<TrackBuffer, { released: boolean; release(): void }>();

    /**
     * A subgroup data stream can beat the SUBSCRIBE_OK parse that binds its alias by a microtask (both ride in-memory
     * TransformStreams), so an unknown alias waits for its binding instead of failing. Aliases only ever come from the
     * publisher's own SUBSCRIBE_OKs, and `close()` flushes the waiters with `undefined`, so no wait leaks.
     */
    const aliasWaiters = new Map<number, ((track: TrackBuffer | undefined) => void)[]>();

    const bindAlias = (trackAlias: number, track: TrackBuffer): void => {
      aliasToTrack.set(trackAlias, track);

      for (const resolve of aliasWaiters.get(trackAlias) ?? []) resolve(track);

      aliasWaiters.delete(trackAlias);
    };

    const trackForAlias = (trackAlias: number): Promise<TrackBuffer | undefined> => {
      const track = aliasToTrack.get(trackAlias);
      if (track || !sessionOpen) return Promise.resolve(track);

      return new Promise((resolve) => {
        const waiters = aliasWaiters.get(trackAlias) ?? [];

        waiters.push(resolve);
        aliasWaiters.set(trackAlias, waiters);
      });
    };

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    /**
     * The relay's control stream toward the publisher. It stays open for the session's lifetime — closing it ends the
     * session (§3.3).
     */
    const sendServerSetup = (): void => {
      if (!sessionOpen || destroyed || !uniController) return;

      const pipe = new TransformStream<Uint8Array, Uint8Array>();

      controlWriter = pipe.writable.getWriter();
      void controlWriter.write(encodeSetup());
      uniController.enqueue(pipe.readable);
    };

    /**
     * Open a relay-initiated request stream toward the publisher — the carrier for the SUBSCRIBE_NAMESPACE solicitation
     * and each upstream SUBSCRIBE (the publisher session parks an accept loop on `incomingBidirectionalStreams`).
     */
    const openRequestStream = ():
      | { writer: WritableStreamDefaultWriter<Uint8Array>; reader: StreamByteReader }
      | undefined => {
      if (!sessionOpen || destroyed || !bidiController) return undefined;

      const relayToPublisher = new TransformStream<Uint8Array, Uint8Array>();
      const publisherToRelay = new TransformStream<Uint8Array, Uint8Array>();

      bidiController.enqueue({ readable: relayToPublisher.readable, writable: publisherToRelay.writable });
      return { writer: relayToPublisher.writable.getWriter(), reader: new StreamByteReader(publisherToRelay.readable) };
    };

    /**
     * One live upstream subscription per track: SUBSCRIBE, bind the SUBSCRIBE_OK's alias for the data-stream router,
     * then hold the stream open. It ends by FIN alone (no PUBLISH_DONE exists in this flow) — the publisher's, ending
     * the track for good, or our own via `handle.release()`, withdrawing a track no player watches.
     */
    const runUpstreamSubscription = async (
      track: TrackBuffer,
      namespace: string[],
      stream: { writer: WritableStreamDefaultWriter<Uint8Array>; reader: StreamByteReader },
      handle: { released: boolean; release(): void },
      attempt: number
    ): Promise<void> => {
      const { writer, reader } = stream;

      openReaders.add(reader);
      requestWriters.add(writer);
      let trackAlias: number | undefined;
      let retryWhileWanted = false;

      try {
        await writer.write(encodeSubscribe(takeRequestId(), namespace, track.name));
        const response = await readControlFrame(reader);

        if (response.type !== MESSAGE_TYPE.SUBSCRIBE_OK) {
          if (response.type === MESSAGE_TYPE.REQUEST_ERROR) {
            const fields = new Reader(response.body);
            const errorCode = fields.varint();

            fields.varint(); // retry interval
            const reason = fields.string();

            if (errorCode === ERROR_DOES_NOT_EXIST && track.ended) {
              // Done, not late: the publisher FINed this track and has
              // not re-registered it, so DOES_NOT_EXIST is terminal —
              // mirror the real relay, which aborts the request rather
              // than retrying, by ending the late subscribers. Each
              // later player subscribe re-probes once, which is how a
              // re-registered name is discovered.
              log(`upstream SUBSCRIBE ${track.name}: the track ended — ending its late subscribers`);

              for (const subscriber of [...track.subscribers]) subscriber.end();
            } else if (errorCode === ERROR_DOES_NOT_EXIST) {
              // Not registered *yet* — a player can want a track before
              // the publisher brings it up (screen share starting after
              // the viewer joined). The relay hub retries while demand
              // stands; the finally below schedules the same. Log only
              // the first miss, not every poll.
              retryWhileWanted = true;

              if (attempt === 0) {
                log(`upstream SUBSCRIBE ${track.name}: not registered yet — retrying while a player waits`);
              }
            } else {
              log(`upstream SUBSCRIBE ${track.name} rejected (code ${errorCode}: ${reason})`);
            }
          } else {
            log(`unexpected 0x${response.type.toString(16)} answering SUBSCRIBE ${track.name}`);
          }

          return;
        }

        // SUBSCRIBE_OK (§10.8): track alias + message parameters
        // (count-prefixed; the publish engine sends none — per-type
        // encodings make a non-empty block unskippable) + track-property
        // KVPs to the end of the body (delta-encoded types; even type →
        // varint value, odd → length-prefixed bytes). TIMESCALE is the
        // one property the engine declares (LOC stamps in microseconds).
        const fields = new Reader(response.body);

        trackAlias = fields.varint();
        let timescale: number | undefined;

        if (fields.varint() === 0) {
          let previousType = 0;

          while (fields.offset < response.body.length) {
            const propertyType = previousType + fields.varint();

            previousType = propertyType;
            const value = propertyType % 2 === 0 ? fields.varint() : fields.slice(fields.varint());

            if (propertyType === TRACK_PROPERTY_TIMESCALE && typeof value === 'number') timescale = value;
          }
        }

        bindAlias(trackAlias, track);
        // A fresh acceptance is the re-registration signal: the name is
        // live again, so a later DOES_NOT_EXIST means late, not done.
        track.ended = false;
        stats.publishedTracks.push(track.name);
        log(
          `upstream SUBSCRIBE ${track.name} → alias ${trackAlias}${timescale === undefined ? '' : ` (timescale ${timescale})`}`
        );

        // Hold for the FIN — the publisher's clean track end, or our own
        // release. A subscription ends by FIN *alone*: any byte after
        // SUBSCRIBE_OK is a protocol violation, and the real relay
        // aborts the track for every viewer — mirror that by ending each
        // downstream subscription rather than silently draining.
        if (!(await reader.atEnd())) {
          log(`upstream ${track.name}: data after SUBSCRIBE_OK — aborting the track for its viewers`);

          for (const subscriber of [...track.subscribers]) subscriber.end();
        } else if (handle.released) {
          log(`upstream unsubscribe ${track.name} — no player interest`);
        } else {
          // The publisher's FIN is the END of the track: propagate it —
          // the same clean FIN toward every attached viewer — so no
          // player hangs on a dead track and a later publisher session
          // cannot resume stale subscriptions. The downstream teardowns'
          // releaseUpstream calls land after this routine's finally has
          // emptied the handle map, so the unwind cannot recurse; and
          // with `retryWhileWanted` unset, no retry loop starts (the
          // track is done, not late).
          log(`upstream track ${track.name} ended`);
          track.ended = true;
          // The retained GOP is dead media: a late joiner must not be
          // handed the final frames of a track that is over.
          track.groups.clear();

          for (const subscriber of [...track.subscribers]) subscriber.end();
        }
      } catch {
        // Stream reset or session teardown — the close path owns cleanup.
      } finally {
        openReaders.delete(reader);
        requestWriters.delete(writer);
        writer.close().catch(() => {});
        // Cancel unconditionally: on the violation path the publisher may
        // keep writing, and the reader just left `openReaders`, so nothing
        // else would ever reset the stream. A no-op on the FIN paths.
        reader.cancel();

        if (upstreamByTrack.get(track) === handle) upstreamByTrack.delete(track);

        if (trackAlias !== undefined) {
          aliasToTrack.delete(trackAlias);

          // A straggler data stream may be parked on the dead alias.
          for (const resolve of aliasWaiters.get(trackAlias) ?? []) resolve(undefined);

          aliasWaiters.delete(trackAlias);
          const index = stats.publishedTracks.indexOf(track.name);

          if (index >= 0) stats.publishedTracks.splice(index, 1);
        }

        // Re-issue paths, both gated on standing demand. Release: a
        // player that subscribed during the release window hit the
        // released handle's dedupe and was dropped — pull again now that
        // the old handle is gone. DOES_NOT_EXIST: poll until the
        // publisher registers the track. A publisher-side FIN re-issues
        // nothing — the track is done, and re-subscribing a still-watched
        // track would loop through DOES_NOT_EXIST forever.
        if (sessionOpen && !destroyed && track.subscribers.size > 0) {
          if (handle.released) {
            subscribeUpstream(track);
          } else if (retryWhileWanted) {
            const timer = setTimeout(() => {
              retryTimers.delete(timer);

              if (track.subscribers.size > 0) subscribeUpstream(track, attempt + 1);
            }, UPSTREAM_RETRY_DELAY_MS);

            retryTimers.add(timer);
          }
        }
      }
    };

    const subscribeUpstream = (track: TrackBuffer, attempt = 0): void => {
      if (!sessionOpen || destroyed || announcedNamespace === undefined) return;

      if (upstreamByTrack.has(track)) return;

      const stream = openRequestStream();
      if (!stream) return;

      const handle = {
        released: false,
        release(): void {
          if (handle.released) return;

          handle.released = true;
          // FIN with no trailing bytes — the clean unsubscribe; the hold
          // loop unwinds through the reader cancel and cleans up.
          stream.writer.close().catch(() => {});
          stream.reader.cancel();
        },
      };

      upstreamByTrack.set(track, handle);
      void runUpstreamSubscription(track, announcedNamespace, stream, handle, attempt);
    };

    /** Withdraw the upstream pull once no player watches the track. */
    const releaseUpstream = (track: TrackBuffer): void => {
      upstreamByTrack.get(track)?.release();
    };

    /**
     * Solicit announces: SUBSCRIBE_NAMESPACE for the empty prefix, then hold the stream for the session's lifetime —
     * REQUEST_OK first, then NAMESPACE / NAMESPACE_DONE entries (suffix-relative to the prefix, so with an empty prefix
     * each announced namespace arrives whole).
     */
    const runNamespaceSolicitation = async (): Promise<void> => {
      const stream = openRequestStream();
      if (!stream) return;

      const { writer, reader } = stream;

      openReaders.add(reader);
      requestWriters.add(writer);

      try {
        await writer.write(encodeSubscribeNamespace(takeRequestId()));
        const response = await readControlFrame(reader);

        if (response.type !== MESSAGE_TYPE.REQUEST_OK) {
          log(`SUBSCRIBE_NAMESPACE answered with 0x${response.type.toString(16)}`);
          return;
        }

        while (!(await reader.atEnd())) {
          const message = await readControlFrame(reader);

          if (message.type === MESSAGE_TYPE.NAMESPACE) {
            announcedNamespace = readNamespaceTuple(new Reader(message.body));
            log(`publisher NAMESPACE ${announcedNamespace.join('/')}`);

            // Players may already be waiting (a re-publish under a live
            // player) — pull every track that has a subscriber.
            for (const track of tracks.values()) {
              if (track.subscribers.size > 0) subscribeUpstream(track);
            }
          } else if (message.type === MESSAGE_TYPE.NAMESPACE_DONE) {
            log(`publisher NAMESPACE_DONE ${readNamespaceTuple(new Reader(message.body)).join('/')}`);
            announcedNamespace = undefined;
          } else {
            log(`unexpected 0x${message.type.toString(16)} on the namespace stream`);
          }
        }
      } catch {
        // Stream reset or session teardown — the close path owns cleanup.
      } finally {
        openReaders.delete(reader);
        requestWriters.delete(writer);
        writer.close().catch(() => {});
      }
    };

    /** Parse one subgroup data stream (subgroup-writer's shape, §11.4.2). */
    const handleSubgroupStream = async (reader: StreamByteReader, type: number): Promise<void> => {
      const hasProperties = (type & SUBGROUP_FLAG.PROPERTIES) !== 0;
      const explicitSubgroupId = (type & SUBGROUP_FLAG.SUBGROUP_ID_MODE_MASK) >> 1 === 0b10;
      const trackAlias = await reader.readVarint();
      const groupId = await reader.readVarint();

      if (explicitSubgroupId) await reader.readVarint();

      if ((type & SUBGROUP_FLAG.DEFAULT_PRIORITY) === 0) await reader.readUint8();

      const track = await trackForAlias(trackAlias);

      if (!track) {
        // Only reachable at session close, when the waiters flush empty.
        reader.cancel();
        return;
      }

      // First object ID is absolute; the rest are `delta + 1` (§11.4.2).
      let previousObjectId: number | undefined;

      while (!(await reader.atEnd())) {
        const delta = await reader.readVarint();
        const objectId = previousObjectId === undefined ? delta : previousObjectId + delta + 1;

        previousObjectId = objectId;
        let properties: Uint8Array = new Uint8Array(0);

        if (hasProperties) {
          const length = await reader.readVarint();

          if (length > 0) properties = await reader.readBytes(length);
        }

        const payloadLength = await reader.readVarint();
        let payload: Uint8Array = new Uint8Array(0);

        if (payloadLength === 0) {
          await reader.readVarint(); // Object Status
        } else {
          payload = await reader.readBytes(payloadLength);
        }

        bufferAndForward(track, { groupId, objectId, properties, payload });
      }
    };

    const handlePublisherUniStream = async (readable: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = new StreamByteReader(readable);

      openReaders.add(reader);

      try {
        const streamType = await reader.readVarint();

        if (streamType === MESSAGE_TYPE.SETUP) {
          // The publisher's control stream: SETUP and then silence (the
          // publish engine never sends GOAWAY — the known relay lineage
          // treats a client GOAWAY as session-fatal). Drain until it ends.
          log('publisher SETUP received');

          while (!(await reader.atEnd())) await reader.readUint8();
        } else if (isSubgroupHeaderType(streamType)) {
          await handleSubgroupStream(reader, streamType);
        } else if (streamType === STREAM_TYPE_PADDING) {
          reader.cancel();
        } else {
          log(`unexpected publisher stream type 0x${streamType.toString(16)}`);
          reader.cancel();
        }
      } catch {
        // Stream reset — the drop path for a group under backpressure, or
        // session teardown. Objects already buffered stay valid.
      } finally {
        openReaders.delete(reader);
      }
    };

    /**
     * Publisher-initiated request streams. Announce-and-serve means the relay initiates everything, so nothing arrives
     * here from the current engine — a proactive-PUBLISH client from before the rework is the only sender. Mirror
     * moq-relay 0.14.7: reject the PUBLISH with a request error and finish the stream.
     */
    const handlePublisherRequestStream = async (stream: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }): Promise<void> => {
      const writer = stream.writable.getWriter();
      const reader = new StreamByteReader(stream.readable);

      openReaders.add(reader);

      try {
        const message = await readControlFrame(reader);

        if (message.type === MESSAGE_TYPE.PUBLISH) {
          await writer.write(encodeRequestError(ERROR_PUBLISH_NOT_SUPPORTED, 'PUBLISH is not supported'));
          log('publisher PUBLISH rejected — announce-and-serve only');
        } else {
          log(`unexpected publisher request 0x${message.type.toString(16)}`);
        }
      } catch {
        // Aborted request stream — nothing left to answer.
      } finally {
        openReaders.delete(reader);
        writer.close().catch(() => {});
        reader.cancel();
      }
    };

    const close = (): void => {
      if (!sessionOpen) return;

      sessionOpen = false;
      closeTransports.delete(close);

      if (requestUpstreamTrack === subscribeUpstream) requestUpstreamTrack = undefined;

      if (releaseUpstreamTrack === releaseUpstream) releaseUpstreamTrack = undefined;

      stats.publisherState = 'closed';

      // Release any subgroup handlers still parked on an alias binding.
      for (const waiters of aliasWaiters.values()) {
        for (const resolve of waiters) resolve(undefined);
      }

      aliasWaiters.clear();

      for (const reader of [...openReaders]) reader.cancel();

      openReaders.clear();

      // Abort (not close): a request writer may have a write parked on a
      // stream the dying session will never read.
      for (const writer of [...requestWriters]) writer.abort().catch(() => {});

      requestWriters.clear();

      for (const timer of retryTimers) clearTimeout(timer);

      retryTimers.clear();
      controlWriter?.close().catch(() => {});
      controlWriter = undefined;

      for (const controller of [uniController, bidiController]) {
        try {
          controller?.close();
        } catch {
          // Already closed or errored — nothing to release.
        }
      }

      uniController = undefined;
      bidiController = undefined;
      resolveClosed();
      log('publisher transport closed');
    };

    closeTransports.add(close);

    const transport = {
      incomingUnidirectionalStreams: new ReadableStream<ReadableStream<Uint8Array>>({
        start(controller) {
          uniController = controller;
        },
      }),
      // The relay's own requests toward the publisher ride here: the
      // SUBSCRIBE_NAMESPACE solicitation right after SETUP, then one
      // SUBSCRIBE per player-wanted track (`openRequestStream`).
      incomingBidirectionalStreams: new ReadableStream<{
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      }>({
        start(controller) {
          bidiController = controller;
        },
      }),
      createUnidirectionalStream: async () => {
        const pipe = new TransformStream<Uint8Array, Uint8Array>();

        void handlePublisherUniStream(pipe.readable);
        return pipe.writable;
      },
      createBidirectionalStream: async () => {
        const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
        const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

        void handlePublisherRequestStream({ readable: clientToServer.readable, writable: serverToClient.writable });
        return { readable: serverToClient.readable, writable: clientToServer.writable };
      },
      close,
      closed,
    };

    log(`publisher transport connected (namespace ${endpoint.namespace.join('/') || '—'})`);
    requestUpstreamTrack = subscribeUpstream;
    releaseUpstreamTrack = releaseUpstream;
    // Server SETUP right after connect on its own control stream, then the
    // announce solicitation — the order the real relay opens them.
    queueMicrotask(() => {
      sendServerSetup();
      void runNamespaceSolicitation();
    });

    return { transport, ready: Promise.resolve() };
  };

  // ==========================================================================
  // Player side — serves `setupMoqSession` transports (SUBSCRIBE + forward)
  // ==========================================================================

  const createMoqTransport: CreateMoqTransport = () => {
    let sessionOpen = true;
    let uniController: ReadableStreamDefaultController<ReadableStream<Uint8Array>> | undefined;
    let bidiController: ReadableStreamDefaultController<never> | undefined;
    let controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const abortRequestStreams = new Set<() => void>();

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    /**
     * Forward one object on its own unidirectional stream. The FIN matters: a subgroup stream is read until
     * end-of-stream, so an unclosed stream would leave the last object unterminated.
     */
    const publishObject = (bytes: Uint8Array): void => {
      if (!sessionOpen || destroyed || !uniController) return;

      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const writer = pipe.writable.getWriter();

      void writer.write(bytes).then(
        () => writer.close(),
        () => {}
      );
      uniController.enqueue(pipe.readable);
      stats.objectsForwarded++;
    };

    const sendServerSetup = (): void => {
      if (!sessionOpen || destroyed || !uniController) return;

      const pipe = new TransformStream<Uint8Array, Uint8Array>();

      controlWriter = pipe.writable.getWriter();
      void controlWriter.write(encodeSetup());
      uniController.enqueue(pipe.readable);
    };

    async function handleRequestStream(stream: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }): Promise<void> {
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      let buffer = new Uint8Array(0);
      let subscription: PlayerSubscription | undefined;
      let subscribedTrack: TrackBuffer | undefined;

      const abort = () => {
        void reader.cancel().catch(() => {});
      };

      abortRequestStreams.add(abort);

      /** Accumulate until a whole framed control message is available. */
      const takeMessage = (): { type: number; body: Uint8Array } | null => {
        if (buffer.length < 3) return null;

        const header = new Reader(buffer);
        const type = header.varint();
        const bodyStart = header.offset + 2;
        if (buffer.length < bodyStart) return null;

        const length = buffer[header.offset]! * 256 + buffer[header.offset + 1]!;
        const total = bodyStart + length;
        if (buffer.length < total) return null;

        const body = buffer.subarray(bodyStart, total);

        buffer = buffer.slice(total);
        return { type, body };
      };

      const onSubscribe = (body: Uint8Array): void => {
        const fields = new Reader(body);

        fields.varint(); // request id — correlation is per-stream here
        const namespaceFields = fields.varint();

        for (let i = 0; i < namespaceFields; i++) fields.string();

        const trackName = fields.string();

        const trackAlias = nextPlayerTrackAlias++;

        void writer.write(encodeSubscribeOk(trackAlias));

        // The track may not exist yet (player subscribed before the
        // publisher went live) — the subscription waits, and the announce
        // handler pulls every subscribed track once the namespace lands.
        const track = trackFor(trackName);

        // Announce-and-serve: player interest is what makes the relay
        // SUBSCRIBE upstream (catalog first, then the catalog's tracks).
        requestUpstreamTrack?.(track);
        subscription = {
          trackAlias,
          deliver: (object) =>
            publishObject(
              encodeObjectStream(trackAlias, object.groupId, object.objectId, object.properties, object.payload)
            ),
          end: () => {
            // FIN toward the player (the clean track end), then cancel
            // our read side — the loop's teardown removes the entry.
            writer.close().catch(() => {});
            abort();
          },
        };
        // Replay + register back-to-back (no await between): nothing can
        // interleave, so the subscriber sees every object exactly once.
        replayNewestGroup(track, subscription);
        track.subscribers.add(subscription);
        subscribedTrack = track;
        stats.subscriptions.push(trackName);
        log(`player subscribe ${trackName} → alias ${trackAlias}`);
      };

      try {
        while (true) {
          const message = takeMessage();

          if (message) {
            if (message.type === MESSAGE_TYPE.SUBSCRIBE) {
              onSubscribe(message.body);
            } else if (message.type === MESSAGE_TYPE.FETCH) {
              // No history beyond the ring buffer: the engine falls back to
              // joining live, which is what a live loopback stream is.
              await writer.write(encodeRequestError(ERROR_INVALID_RANGE, 'nothing published'));
              await writer.close();
              return;
            }

            continue;
          }

          const { value, done } = await reader.read();
          // Cancellation *is* the stream lifecycle (§3.3.3): the subscriber
          // aborting its sending direction ends the subscription.
          if (done) break;

          const merged = new Uint8Array(buffer.length + value.length);

          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;
        }
      } catch {
        // Aborted request stream — same teardown as a graceful end.
      } finally {
        abortRequestStreams.delete(abort);

        if (subscribedTrack && subscription) {
          subscribedTrack.subscribers.delete(subscription);
          const index = stats.subscriptions.indexOf(subscribedTrack.name);

          if (index >= 0) stats.subscriptions.splice(index, 1);

          log(`player unsubscribe ${subscribedTrack.name}`);

          // Pull-through: the last player leaving withdraws the upstream
          // subscription; a later subscribe pulls the track afresh.
          if (subscribedTrack.subscribers.size === 0) releaseUpstreamTrack?.(subscribedTrack);
        }

        writer.close().catch(() => {});
      }
    }

    const close = (): void => {
      if (!sessionOpen) return;

      sessionOpen = false;
      closeTransports.delete(close);

      for (const abortStream of [...abortRequestStreams]) abortStream();

      abortRequestStreams.clear();
      controlWriter?.close().catch(() => {});
      controlWriter = undefined;

      for (const controller of [uniController, bidiController]) {
        try {
          controller?.close();
        } catch {
          // Already closed or errored — nothing to release.
        }
      }

      uniController = undefined;
      bidiController = undefined;
      resolveClosed();
      log('player transport closed');
    };

    closeTransports.add(close);

    const transport = {
      incomingUnidirectionalStreams: new ReadableStream<ReadableStream<Uint8Array>>({
        start(controller) {
          uniController = controller;
        },
      }),
      // Nothing arrives here — this relay never initiates a request toward
      // the player — but the session parks a reader on it.
      incomingBidirectionalStreams: new ReadableStream<never>({
        start(controller) {
          bidiController = controller;
        },
      }),
      // The player's own control stream: SETUP and GOAWAY land here and
      // nothing in this relay reacts to them.
      createUnidirectionalStream: async () => new WritableStream<Uint8Array>(),
      createBidirectionalStream: async () => {
        const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
        const serverToClient = new TransformStream<Uint8Array, Uint8Array>();

        void handleRequestStream({ readable: clientToServer.readable, writable: serverToClient.writable });
        return { readable: serverToClient.readable, writable: clientToServer.writable };
      },
      close,
      closed,
    };

    log('player transport connected');
    queueMicrotask(sendServerSetup);

    return { transport, ready: Promise.resolve() };
  };

  return {
    connectPublisher,
    createMoqTransport,
    src: `moqt://loopback.videojs.test/live#msf:${NAMESPACE}--${CATALOG_TRACK}`,
    stats,
    destroy() {
      destroyed = true;

      for (const close of [...closeTransports]) close();
    },
  };
}
