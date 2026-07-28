/**
 * Loopback MoQ relay — a synthetic MSF publisher for the sandbox.
 *
 * There is no public relay that serves draft-ietf-moq-msf-01 catalogs yet
 * (Phase 0 interop is still owed), so this stands in for one: it speaks real
 * draft-19 bytes over an in-memory `MoqtTransport` and publishes real
 * WebCodecs-encoded media, which is enough to drive the whole engine —
 * catalog → selection → subscribe → decode → canvas + AudioContext.
 *
 * The wire encoding here is written from the specs rather than reusing
 * `network/moqt`'s encoders (they aren't public API, and a second
 * independent implementation is worth more as a check on the decoder than a
 * round-trip against ourselves would be).
 *
 * Published tracks (subscribe lazily starts a producer per subscription):
 *
 * - `video-hi` — VP8 640×360, ~1.2 Mbps
 * - `video-lo` — VP8 320×180, ~300 Kbps
 * - `audio`    — Opus 48 kHz stereo, 64 Kbps
 */
import type { CreateMoqTransport } from '@videojs/spf/moq';

// ============================================================================
// Wire primitives (draft-ietf-moq-transport-19)
// ============================================================================

/** Control/request message types (§10, Table 5). */
const MESSAGE_TYPE = {
  SETUP: 0x2f00,
  SUBSCRIBE: 0x3,
  SUBSCRIBE_OK: 0x4,
  REQUEST_ERROR: 0x5,
  FETCH: 0x16,
} as const;

/** REQUEST_ERROR code for "nothing published in that range" (§10.6.1). */
const ERROR_INVALID_RANGE = 0x11;

/**
 * SUBGROUP_HEADER stream type: subgroup-id mode `zero`, default publisher
 * priority, objects carry a Properties field, not end-of-group.
 * `0b0011_0001` — see §11.4.2 for the flag layout.
 */
const SUBGROUP_HEADER_TYPE = 0x31;

/** LOC property IDs (draft-ietf-moq-loc-02 §2.3). */
const LOC_TIMESTAMP = 0x06;

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

  /** Varint length prefix + payload — the shape of names, reasons, and values. */
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

function encodeRequestError(errorCode: number, reason: string): Uint8Array {
  const body = new Writer().varint(errorCode).varint(0).lengthPrefixed(new TextEncoder().encode(reason));
  return frame(MESSAGE_TYPE.REQUEST_ERROR, body.toBytes());
}

/**
 * One LOC-packaged object on its own subgroup stream. MSF publishes one
 * object per stream (§4.1), which also makes each object's ID absolute.
 */
function encodeObjectStream(
  trackAlias: number,
  groupId: number,
  objectId: number,
  timestampUs: number,
  payload: Uint8Array
): Uint8Array {
  const properties = new Writer().varint(LOC_TIMESTAMP).varint(timestampUs).toBytes();
  return new Writer()
    .varint(SUBGROUP_HEADER_TYPE)
    .varint(trackAlias)
    .varint(groupId)
    .varint(objectId)
    .lengthPrefixed(properties)
    .lengthPrefixed(payload)
    .toBytes();
}

// ============================================================================
// Published catalog
// ============================================================================

interface VideoTrackSpec {
  name: string;
  width: number;
  height: number;
  bitrate: number;
}

const FPS = 30;
/** One MOQT group per GOP (msf-01 §4.1) — 2s at 30fps. */
const GOP_SIZE = 60;

const VIDEO_TRACKS: VideoTrackSpec[] = [
  { name: 'video-hi', width: 640, height: 360, bitrate: 1_200_000 },
  { name: 'video-lo', width: 320, height: 180, bitrate: 300_000 },
];

const AUDIO_TRACK = {
  name: 'audio',
  sampleRate: 48_000,
  channels: 2,
  bitrate: 64_000,
  /** Opus accepts 2.5/5/10/20/40/60ms frames; 20ms at 48 kHz is 960 samples. */
  frameSamples: 960,
} as const;

/** Objects per audio group, so a group boundary (`objectId === 0`) lands every second. */
const AUDIO_GROUP_OBJECTS = 50;

function buildCatalog(): string {
  return JSON.stringify({
    version: '1',
    tracks: [
      ...VIDEO_TRACKS.map((track) => ({
        name: track.name,
        packaging: 'loc',
        isLive: true,
        role: 'video',
        codec: 'vp8',
        width: track.width,
        height: track.height,
        framerate: FPS,
        bitrate: track.bitrate,
      })),
      {
        name: AUDIO_TRACK.name,
        packaging: 'loc',
        isLive: true,
        role: 'audio',
        codec: 'opus',
        samplerate: AUDIO_TRACK.sampleRate,
        channelConfig: String(AUDIO_TRACK.channels),
        bitrate: AUDIO_TRACK.bitrate,
      },
    ],
  });
}

// ============================================================================
// Producers
// ============================================================================

interface ProducerHost {
  /** Media-timeline microseconds, shared by every producer on this relay. */
  nowUs(): number;
  publish(bytes: Uint8Array): void;
  log(message: string): void;
}

/**
 * Animated test pattern: a sweeping bar plus the rendition label and clock,
 * so a rendition switch and a frozen picture are both visible at a glance.
 */
function drawFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  spec: VideoTrackSpec,
  frameIndex: number,
  timestampUs: number
): void {
  const { width, height } = spec;
  const phase = (frameIndex % (FPS * 4)) / (FPS * 4);

  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = `hsl(${Math.round(phase * 360)} 80% 55%)`;
  ctx.fillRect(phase * width, 0, Math.max(4, width * 0.06), height);

  ctx.fillStyle = '#f4f4f5';
  ctx.font = `600 ${Math.round(height * 0.11)}px monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText(`${spec.width}×${spec.height}`, width * 0.06, height * 0.1);
  ctx.font = `${Math.round(height * 0.08)}px monospace`;
  ctx.fillText(`${(timestampUs / 1_000_000).toFixed(2)}s`, width * 0.06, height * 0.28);
  ctx.fillText(`#${frameIndex}`, width * 0.06, height * 0.42);
}

function startVideoProducer(spec: VideoTrackSpec, trackAlias: number, host: ProducerHost): () => void {
  const canvas = new OffscreenCanvas(spec.width, spec.height);
  const ctx = canvas.getContext('2d')!;

  let frameIndex = 0;
  // Group 0 is the catalog's; media groups start at 1 so a keyframe always
  // opens a group the subscriber has not already watermarked.
  let groupId = 0;
  let objectId = 0;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      // VP8 has no frame reordering, so output order is encode order: a key
      // chunk opens the next group, deltas extend it.
      if (chunk.type === 'key') {
        groupId++;
        objectId = 0;
      } else {
        objectId++;
      }
      host.publish(encodeObjectStream(trackAlias, groupId, objectId, chunk.timestamp, payload));
    },
    error: (error) => host.log(`${spec.name} encoder error: ${error.message}`),
  });

  encoder.configure({
    codec: 'vp8',
    width: spec.width,
    height: spec.height,
    bitrate: spec.bitrate,
    framerate: FPS,
    latencyMode: 'realtime',
  });

  const interval = setInterval(() => {
    if (encoder.state !== 'configured') return;
    const timestampUs = host.nowUs();
    drawFrame(ctx, spec, frameIndex, timestampUs);
    const frame = new VideoFrame(canvas, { timestamp: timestampUs, duration: Math.round(1_000_000 / FPS) });
    encoder.encode(frame, { keyFrame: frameIndex % GOP_SIZE === 0 });
    frame.close();
    frameIndex++;
  }, 1000 / FPS);

  return () => {
    clearInterval(interval);
    if (encoder.state !== 'closed') encoder.close();
  };
}

function startAudioProducer(trackAlias: number, host: ProducerHost): () => void {
  const { sampleRate, channels, bitrate, frameSamples } = AUDIO_TRACK;
  const frameDurationUs = Math.round((frameSamples / sampleRate) * 1_000_000);

  let groupId = 0;
  let objectId = AUDIO_GROUP_OBJECTS;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      // Every Opus packet is independently decodable; the group boundary is
      // only there to give the jitter buffer a random-access point.
      if (objectId >= AUDIO_GROUP_OBJECTS) {
        groupId++;
        objectId = 0;
      } else {
        objectId++;
      }
      host.publish(encodeObjectStream(trackAlias, groupId, objectId, chunk.timestamp, payload));
    },
    error: (error) => host.log(`audio encoder error: ${error.message}`),
  });

  encoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels, bitrate });

  // A quiet arpeggio over a sine carrier — audible enough to tell whether the
  // master clock is running, soft enough to leave on.
  const NOTES = [220, 277.18, 329.63, 415.3];
  let sampleCursor = 0;
  let nextTimestampUs = host.nowUs();

  const emit = () => {
    const planar = new Float32Array(frameSamples * channels);
    for (let i = 0; i < frameSamples; i++) {
      const t = (sampleCursor + i) / sampleRate;
      const note = NOTES[Math.floor(t * 2) % NOTES.length]!;
      const envelope = 0.12 * (1 - ((t * 2) % 1));
      const value = Math.sin(2 * Math.PI * note * t) * envelope;
      planar[i] = value;
      planar[frameSamples + i] = value;
    }

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frameSamples,
      numberOfChannels: channels,
      timestamp: nextTimestampUs,
      data: planar,
    });
    encoder.encode(data);
    data.close();

    sampleCursor += frameSamples;
    nextTimestampUs += frameDurationUs;
  };

  // Publish a frame once its capture window has elapsed, catching up if the
  // timer drifts, so timestamps stay gapless on the shared timeline.
  const interval = setInterval(() => {
    if (encoder.state !== 'configured') return;
    const deadline = host.nowUs();
    let emitted = 0;
    while (nextTimestampUs + frameDurationUs <= deadline && emitted < AUDIO_GROUP_OBJECTS) {
      emit();
      emitted++;
    }
  }, frameDurationUs / 1000);

  return () => {
    clearInterval(interval);
    if (encoder.state !== 'closed') encoder.close();
  };
}

// ============================================================================
// Relay
// ============================================================================

export interface LoopbackRelayStats {
  /** Track names currently subscribed, in subscribe order. */
  subscriptions: string[];
  objectsPublished: number;
  bytesPublished: number;
}

export interface LoopbackRelay {
  /** Transport factory to hand the engine through `engineConfig`. */
  createMoqTransport: CreateMoqTransport;
  /** MSF URL that resolves against this relay. */
  src: string;
  stats: LoopbackRelayStats;
  destroy(): void;
}

export interface LoopbackRelayOptions {
  onLog?: (message: string) => void;
}

/** The namespace + catalog track name the published `src` points at. */
const NAMESPACE = 'demo';
const CATALOG_TRACK = 'catalog';

export function createLoopbackRelay({ onLog }: LoopbackRelayOptions = {}): LoopbackRelay {
  const log = (message: string) => onLog?.(message);
  const stats: LoopbackRelayStats = { subscriptions: [], objectsPublished: 0, bytesPublished: 0 };

  let uniController: ReadableStreamDefaultController<ReadableStream<Uint8Array>> | undefined;
  const producers = new Set<() => void>();
  let destroyed = false;

  const epochMs = performance.now();
  const host: ProducerHost = {
    nowUs: () => Math.round((performance.now() - epochMs) * 1000),
    publish: (bytes) => publishObject(bytes),
    log,
  };

  /**
   * Publish one object on its own unidirectional stream. The FIN matters:
   * a subgroup stream is read until end-of-stream, so an unclosed stream
   * would leave the last object unterminated.
   */
  function publishObject(bytes: Uint8Array): void {
    if (destroyed || !uniController) return;
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    const writer = pipe.writable.getWriter();
    void writer.write(bytes).then(
      () => writer.close(),
      () => {}
    );
    uniController.enqueue(pipe.readable);
    stats.objectsPublished++;
    stats.bytesPublished += bytes.length;
  }

  /**
   * The server's control stream. It stays open for the session's lifetime —
   * closing it ends the session (§3.3), so the writer is held until destroy.
   */
  let controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;

  function sendServerSetup(): void {
    if (destroyed || !uniController) return;
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    controlWriter = pipe.writable.getWriter();
    void controlWriter.write(encodeSetup());
    uniController.enqueue(pipe.readable);
  }

  let nextTrackAlias = 1;

  async function handleRequestStream(stream: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }): Promise<void> {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    let buffer = new Uint8Array(0);
    let stopProducer: (() => void) | undefined;
    let subscribedTrack: string | undefined;

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
      const reader = new Reader(body);
      reader.varint(); // request id — correlation is per-stream here
      const namespaceFields = reader.varint();
      for (let i = 0; i < namespaceFields; i++) reader.string();
      const trackName = reader.string();

      const trackAlias = nextTrackAlias++;
      void writer.write(encodeSubscribeOk(trackAlias));
      subscribedTrack = trackName;
      stats.subscriptions.push(trackName);
      log(`subscribe ${trackName} → alias ${trackAlias}`);

      if (trackName === CATALOG_TRACK) {
        publishObject(encodeObjectStream(trackAlias, 0, 0, 0, new TextEncoder().encode(buildCatalog())));
        return;
      }

      const video = VIDEO_TRACKS.find((track) => track.name === trackName);
      if (video) {
        stopProducer = startVideoProducer(video, trackAlias, host);
      } else if (trackName === AUDIO_TRACK.name) {
        stopProducer = startAudioProducer(trackAlias, host);
      } else {
        log(`subscribe for unknown track ${trackName}`);
        return;
      }
      producers.add(stopProducer);
    };

    try {
      while (true) {
        const message = takeMessage();
        if (message) {
          if (message.type === MESSAGE_TYPE.SUBSCRIBE) {
            onSubscribe(message.body);
          } else if (message.type === MESSAGE_TYPE.FETCH) {
            // No history is retained: the engine falls back to joining the
            // live catalog track, which is what a fresh live stream does.
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
      if (stopProducer) {
        stopProducer();
        producers.delete(stopProducer);
      }
      if (subscribedTrack) {
        const index = stats.subscriptions.indexOf(subscribedTrack);
        if (index >= 0) stats.subscriptions.splice(index, 1);
        log(`unsubscribe ${subscribedTrack}`);
      }
      writer.close().catch(() => {});
    }
  }

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const createMoqTransport: CreateMoqTransport = () => {
    const transport = {
      incomingUnidirectionalStreams: new ReadableStream<ReadableStream<Uint8Array>>({
        start(controller) {
          uniController = controller;
        },
      }),
      incomingBidirectionalStreams: new ReadableStream<never>({ start() {} }),
      // The subscriber's own control stream: SETUP and GOAWAY land here and
      // nothing in this relay reacts to them.
      createUnidirectionalStream: async () => new WritableStream<Uint8Array>(),
      createBidirectionalStream: async () => {
        const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
        const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
        void handleRequestStream({ readable: clientToServer.readable, writable: serverToClient.writable });
        return { readable: serverToClient.readable, writable: clientToServer.writable };
      },
      close: () => resolveClosed?.(),
      closed,
    };

    log('transport connected');
    // Server SETUP arrives right after connect, on its own control stream.
    queueMicrotask(() => {
      sendServerSetup();
      log('server SETUP sent');
    });

    return { transport, ready: Promise.resolve() };
  };

  return {
    createMoqTransport,
    src: `moqt://loopback.videojs.test/live#msf:${NAMESPACE}--${CATALOG_TRACK}`,
    stats,
    destroy() {
      destroyed = true;
      for (const stop of producers) stop();
      producers.clear();
      controlWriter?.close().catch(() => {});
      controlWriter = undefined;
      resolveClosed?.();
    },
  };
}
