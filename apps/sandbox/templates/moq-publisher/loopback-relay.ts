/**
 * Loopback MoQ relay for the publisher sandbox — an in-page relay that sits
 * between the real publish engine and the real playback engine.
 *
 * One side accepts a `MoqPublishMedia` session through its
 * `connectTransport` seam: it answers the SETUP exchange, accepts the
 * advisory PUBLISH_NAMESPACE and the per-track PUBLISHes (catalog, video,
 * audio) with REQUEST_OK, and parses the publisher's subgroup data streams
 * into per-track object buffers (a small ring of the most recent groups).
 * The other side serves `MoqMediaMixin` player sessions through their
 * `createMoqTransport` seam exactly like `spf-moq-player`'s loopback: SETUP,
 * SUBSCRIBE answered with SUBSCRIBE_OK, FETCH rejected (no history), and
 * objects forwarded one-per-stream — replaying the newest buffered group on
 * subscribe (a keyframe opens every video group, so joining is instant) and
 * live-forwarding from there. Multiple sequential player sessions re-serve
 * the latest catalog.
 *
 * The wire encoding is written from the specs rather than reusing
 * `network/moqt`'s codecs (they are not public API); the byte-level shapes
 * mirror `spf-moq-player/loopback-relay.ts`, extended with the
 * publisher-facing decoders (draft-ietf-moq-transport-19 §10, §11.4.2). If
 * this grows further, the pieces worth exporting properly from
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
  PUBLISH_NAMESPACE: 0x6,
  REQUEST_OK: 0x7,
  PUBLISH_DONE: 0xb,
  FETCH: 0x16,
  PUBLISH: 0x1d,
} as const;

/** REQUEST_ERROR code for "nothing published in that range" (§10.6.1). */
const ERROR_INVALID_RANGE = 0x11;

/**
 * SUBGROUP_HEADER stream type used toward the *player*: subgroup-id mode
 * `zero`, default publisher priority, objects carry a Properties field —
 * `0b0011_0001` (§11.4.2), the same shape `spf-moq-player`'s loopback
 * publishes and the engine demonstrably consumes.
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
 * The vi64 varint of draft-15+ (§1.4.1) — leading ones on the first byte
 * give the encoded length minus one, so an L-byte encoding carries 7L value
 * bits. NOT the QUIC RFC 9000 varint.
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
 * Pull-based reader over a byte stream, for the publisher's long-lived
 * subgroup streams (a group's objects trickle in until FIN at the next
 * keyframe). Minimal mirror of `network/moqt`'s `StreamReader`.
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

function encodeRequestOk(): Uint8Array {
  // Message parameters (count-prefixed, 0) + empty track-properties block.
  return frame(MESSAGE_TYPE.REQUEST_OK, new Writer().varint(0).toBytes());
}

function encodeRequestError(errorCode: number, reason: string): Uint8Array {
  const body = new Writer().varint(errorCode).varint(0).lengthPrefixed(new TextEncoder().encode(reason));
  return frame(MESSAGE_TYPE.REQUEST_ERROR, body.toBytes());
}

/**
 * One forwarded object on its own subgroup stream toward a player. The
 * publisher's Object Properties block (LOC timestamp et al) rides through
 * verbatim as `properties`.
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
}

interface TrackBuffer {
  name: string;
  /** Insertion-ordered groupId → objects; pruned to `MAX_BUFFERED_GROUPS`. */
  groups: Map<number, BufferedObject[]>;
  subscribers: Set<PlayerSubscription>;
}

// ============================================================================
// Relay
// ============================================================================

export interface PublisherLoopbackRelayStats {
  publisherState: 'none' | 'connected' | 'closed';
  /** Track names the publisher has PUBLISHed this session. */
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
      track = { name, groups: new Map(), subscribers: new Set() };
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
   * Replay the newest buffered group so a joining player starts decoding
   * immediately: every group opens with a random-access object (video
   * keyframe / opus packet / whole catalog).
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
  // Publisher side — accepts the publish engine's session
  // ==========================================================================

  const connectPublisher: ConnectPublishTransport = (endpoint) => {
    // Per-session state, so a re-publish starts clean (fresh aliases, and
    // group IDs that restart at 0 must not merge into stale buffers).
    const aliasToTrack = new Map<number, TrackBuffer>();
    for (const track of tracks.values()) track.groups.clear();
    stats.publishedTracks = [];
    stats.publisherState = 'connected';

    let sessionOpen = true;
    let uniController: ReadableStreamDefaultController<ReadableStream<Uint8Array>> | undefined;
    let bidiController: ReadableStreamDefaultController<never> | undefined;
    let controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const openReaders = new Set<StreamByteReader>();

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    /**
     * The relay's control stream toward the publisher. It stays open for the
     * session's lifetime — closing it ends the session (§3.3).
     */
    const sendServerSetup = (): void => {
      if (!sessionOpen || destroyed || !uniController) return;
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      controlWriter = pipe.writable.getWriter();
      void controlWriter.write(encodeSetup());
      uniController.enqueue(pipe.readable);
    };

    /** Parse one subgroup data stream (subgroup-writer's shape, §11.4.2). */
    const handleSubgroupStream = async (reader: StreamByteReader, type: number): Promise<void> => {
      const hasProperties = (type & SUBGROUP_FLAG.PROPERTIES) !== 0;
      const explicitSubgroupId = (type & SUBGROUP_FLAG.SUBGROUP_ID_MODE_MASK) >> 1 === 0b10;
      const trackAlias = await reader.readVarint();
      const groupId = await reader.readVarint();
      if (explicitSubgroupId) await reader.readVarint();
      if ((type & SUBGROUP_FLAG.DEFAULT_PRIORITY) === 0) await reader.readUint8();

      const track = aliasToTrack.get(trackAlias);
      if (!track) {
        log(`data stream for unknown track alias ${trackAlias}`);
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
          // The publisher's control stream: SETUP now, maybe GOAWAY at
          // close. Nothing needs answering here — drain until it ends.
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

    /** PUBLISH / PUBLISH_NAMESPACE request streams (publisher-initiated). */
    const handlePublisherRequestStream = async (stream: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }): Promise<void> => {
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      let buffer = new Uint8Array(0);

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

      try {
        while (true) {
          const message = takeMessage();
          if (message) {
            if (message.type === MESSAGE_TYPE.PUBLISH) {
              const fields = new Reader(message.body);
              fields.varint(); // request id — correlation is per-stream here
              const namespaceFields = fields.varint();
              for (let i = 0; i < namespaceFields; i++) fields.string();
              const trackName = fields.string();
              const trackAlias = fields.varint();
              aliasToTrack.set(trackAlias, trackFor(trackName));
              stats.publishedTracks.push(trackName);
              await writer.write(encodeRequestOk());
              log(`publisher PUBLISH ${trackName} → alias ${trackAlias}`);
            } else if (message.type === MESSAGE_TYPE.PUBLISH_NAMESPACE) {
              await writer.write(encodeRequestOk());
              log('publisher PUBLISH_NAMESPACE accepted');
            } else if (message.type === MESSAGE_TYPE.PUBLISH_DONE) {
              log('publisher PUBLISH_DONE');
            }
            // Everything else (REQUEST_UPDATE, GOAWAY) is ignorable here.
            continue;
          }

          const { value, done } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;
        }
      } catch {
        // Aborted request stream — same teardown as a graceful end.
      } finally {
        writer.close().catch(() => {});
      }
    };

    const close = (): void => {
      if (!sessionOpen) return;
      sessionOpen = false;
      closeTransports.delete(close);
      stats.publisherState = 'closed';
      for (const reader of [...openReaders]) reader.cancel();
      openReaders.clear();
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
      // The relay never subscribes upstream (PUBLISH pushes data
      // unconditionally), but the session parks a reader here, so the
      // controller must be retained to release that accept loop on close.
      incomingBidirectionalStreams: new ReadableStream<never>({
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
    // Server SETUP arrives right after connect, on its own control stream.
    queueMicrotask(sendServerSetup);

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
     * Forward one object on its own unidirectional stream. The FIN matters:
     * a subgroup stream is read until end-of-stream, so an unclosed stream
     * would leave the last object unterminated.
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
        // publisher went live) — the subscription waits and objects flow
        // once the publisher PUBLISHes it.
        const track = trackFor(trackName);
        subscription = {
          trackAlias,
          deliver: (object) =>
            publishObject(
              encodeObjectStream(trackAlias, object.groupId, object.objectId, object.properties, object.payload)
            ),
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
