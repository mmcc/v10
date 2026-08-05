/**
 * Publish-capable MOQT session (moq-transport draft-19), the publish-side
 * sibling of `network/moqt/session.ts`'s subscribe-only driver.
 *
 * Owns the protocol mechanics over an established transport: the SETUP
 * exchange on paired unidirectional control streams (§3.3), the
 * publisher-initiated request streams — PUBLISH per track (§10.10) with
 * PUBLISH_NAMESPACE announcing the namespace first (§10.15) — inbound
 * SUBSCRIBEs for published tracks (answered with SUBSCRIBE_OK carrying
 * the track's alias, §10.8), REQUEST_UPDATE routing, GOAWAY handling, and
 * PUBLISH_DONE on stop (§10.11).
 *
 * Flow choice (per the parent branch's draft-19 notes): the primary flow
 * is publisher-initiated PUBLISH per track. PUBLISH carries the full
 * track name and the publisher-chosen Track Alias, so a peer can accept
 * and start routing without any namespace state; PUBLISH_NAMESPACE is
 * sent first as an advisory announce — a peer that rejects it (e.g. a
 * subscribe-only endpoint answering NOT_SUPPORTED) can still accept the
 * PUBLISHes, so announce rejection is surfaced but never fatal. Inbound
 * SUBSCRIBE answering is implemented as well because relays subscribe to
 * the published tracks to pull data toward downstream demand.
 *
 * Deliberately callback-shaped with NO signals, mirroring the subscribe
 * driver — signal awareness enters at the `publish/` behavior layer
 * through the actor below. Lives in `publish/` rather than `network/moqt`
 * so the parent-owned wire layer keeps only additive sibling files.
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import { StreamReader, utf8Encode } from '../../network/moqt/bytes';
import {
  type ControlMessage,
  decodeControlMessage,
  encodeGoaway,
  encodePublish,
  encodePublishDone,
  encodePublishNamespace,
  encodeRequestError,
  encodeSetup,
  encodeSubscribeOk,
  type KeyValuePair,
  MESSAGE_TYPE,
  type MessageParameters,
  MOQT_PROTOCOL_ID,
  PUBLISH_DONE_STATUS,
  REQUEST_ERROR_CODE,
  SETUP_OPTION,
  type TrackNamespace,
} from '../../network/moqt/control-messages';
import { isMoqtProtocolError, MoqtProtocolError, SESSION_ERROR } from '../../network/moqt/errors';
import { isSubgroupHeaderType, STREAM_TYPE } from '../../network/moqt/object-stream';
import { type BidirectionalStreamLike, openRequestStream, type RequestStream } from '../../network/moqt/request-stream';
import type { Goaway, MoqtTransport } from '../../network/moqt/session';

// =============================================================================
// Driver types
// =============================================================================

/** A publish-side request failure, REQUEST_ERROR-shaped. */
export interface PublishRequestFailure {
  errorCode: number;
  retryInterval: number;
  reason: string;
}

export interface IncomingSubscribe {
  requestId: number;
  trackNamespace: TrackNamespace;
  trackName: string;
  parameters: MessageParameters;
}

export interface MoqtPublishSessionCallbacks {
  /** The server's SETUP arrived; the session is fully established. */
  onReady?(serverOptions: KeyValuePair[]): void;
  /** GOAWAY (control stream or a request stream): stop initiating, migrate. */
  onGoaway?(goaway: Goaway): void;
  /** A PUBLISH offer settled. */
  onPublishResult?(result: {
    trackName: string;
    trackAlias: number;
    accepted: boolean;
    error?: PublishRequestFailure;
  }): void;
  /** PUBLISH_NAMESPACE settled. Rejection is advisory — see the module doc. */
  onNamespaceResult?(result: { accepted: boolean; error?: PublishRequestFailure }): void;
  /** The peer subscribed to a published track (already answered SUBSCRIBE_OK). */
  onSubscribe?(subscribe: IncomingSubscribe): void;
  /** A subscriber's request stream ended (FIN, reset, or track done). */
  onSubscribeEnd?(info: { requestId: number }): void;
  /** REQUEST_UPDATE on a publish or subscribe request stream. */
  onRequestUpdate?(info: { requestId: number; parameters: MessageParameters }): void;
  /** The session ended — transport closed, or a fatal protocol error. */
  onClosed?(info: { error?: unknown }): void;
}

export interface MoqtPublishSessionConfig {
  /** Extra Setup Options to send (an implementation identifier is added automatically). */
  setupOptions?: KeyValuePair[];
  /** Identifies this implementation in SETUP (§10.3.1.5). */
  implementationName?: string;
  /**
   * How long to wait for a PUBLISH / PUBLISH_NAMESPACE response before
   * failing it — the same bound the subscribe driver applies (§3.5's
   * CONTROL_MESSAGE_TIMEOUT rationale). Default 10000ms.
   */
  requestTimeoutMs?: number;
  callbacks?: MoqtPublishSessionCallbacks;
}

export interface PublishTrackOptions {
  trackNamespace: TrackNamespace;
  trackName: string;
  parameters?: MessageParameters;
}

export interface PublishedTrack {
  readonly requestId: number;
  readonly trackAlias: number;
  readonly trackName: string;
  /**
   * Send PUBLISH_DONE on the PUBLISH request stream and on every inbound
   * subscription's stream, then FIN them. Idempotent.
   */
  done(statusCode?: number, streamCount?: number, reason?: string): void;
}

export interface MoqtPublishSession {
  /** Resolves when the server's SETUP has been received. */
  readonly ready: Promise<void>;
  /** Announce the namespace (advisory; result via `onNamespaceResult`). */
  publishNamespace(trackNamespace: TrackNamespace, parameters?: MessageParameters): void;
  /** Offer one track (PUBLISH); acceptance via `onPublishResult`. */
  publishTrack(options: PublishTrackOptions): PublishedTrack;
  /** Open a unidirectional data stream (for a track publisher's subgroups). */
  openUniStream(): Promise<WritableStream<Uint8Array>>;
  /**
   * Orderly stop: send PUBLISH_DONE for any still-live track and GOAWAY,
   * give those control writes a bounded window to reach the wire (closing
   * a WebTransport discards queued data), then close the transport.
   * Synchronous callers return immediately; the transport closes within
   * roughly {@link CLOSE_FLUSH_TIMEOUT_MS}.
   */
  close(closeCode?: number, reason?: string): void;
  destroy(): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_IMPLEMENTATION_NAME = '@videojs/spf moqt publisher';
/**
 * How long `close()` waits for the PUBLISH_DONE / GOAWAY control writes to
 * drain before closing the transport out from under them.
 */
export const CLOSE_FLUSH_TIMEOUT_MS = 250;

// =============================================================================
// Internal records
// =============================================================================

interface PublishRecord {
  requestId: number;
  trackName: string;
  trackAlias: number;
  stream?: RequestStream;
  settled: boolean;
  doneSent: boolean;
}

/** One inbound subscription's stream-side plumbing. */
interface SubscriberStream {
  requestId: number;
  send(bytes: Uint8Array): Promise<void>;
  fin(): Promise<void>;
  cancel(): Promise<void>;
  finished: boolean;
}

interface TrackRecord {
  key: string;
  trackAlias: number;
  publish: PublishRecord;
  subscribers: SubscriberStream[];
  done: boolean;
  /** Settles when the PUBLISH_DONE writes queued by `#finishTrack` land. */
  doneFlushed?: Promise<void>;
}

function trackKey(namespace: TrackNamespace, name: string): string {
  return `${namespace.join('/')}--${name}`;
}

// =============================================================================
// Session driver
// =============================================================================

class MoqtPublishSessionImpl implements MoqtPublishSession {
  readonly ready: Promise<void>;

  #transport: MoqtTransport;
  #config: MoqtPublishSessionConfig;
  #callbacks: MoqtPublishSessionCallbacks;

  #nextRequestId = 0; // client request IDs: even, starting at 0 (§10.1)
  #nextTrackAlias = 0;
  #tracks = new Map<string, TrackRecord>();

  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #receivedServerSetup = false;
  #receivedControlGoaway = false;
  #closing = false;
  #destroyed = false;
  /** Request-response timeout timers still pending — cleared on close. */
  readonly #pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(transport: MoqtTransport, config: MoqtPublishSessionConfig = {}) {
    this.#transport = transport;
    this.#config = config;
    this.#callbacks = config.callbacks ?? {};
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.ready.catch(() => {});

    void this.#start();
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async #start(): Promise<void> {
    void this.#acceptUnidirectionalStreams();
    void this.#acceptBidirectionalStreams();
    void this.#transport.closed.then(
      () => this.#handleClosed(undefined),
      (error) => this.#handleClosed(error)
    );

    try {
      const control = await this.#transport.createUnidirectionalStream();
      this.#controlWriter = control.getWriter();
      // A control stream MUST stay open for the session's lifetime
      // (§3.3) — a peer stopping it has ended the session, so fail now
      // rather than on the next control write or the transport's own
      // `closed` (~an RTT later); the gap is long enough for a busy
      // publisher to keep churning streams against a dying transport.
      // A clean local close resolves the writer instead, and #fatal
      // no-ops once #handleClosed has run.
      void this.#controlWriter.closed.catch((error: unknown) => this.#fatal(error));
      const options: KeyValuePair[] = [
        {
          type: SETUP_OPTION.MOQT_IMPLEMENTATION,
          value: utf8Encode(this.#config.implementationName ?? DEFAULT_IMPLEMENTATION_NAME),
        },
        ...(this.#config.setupOptions ?? []),
      ];
      await this.#controlWriter.write(encodeSetup(options));
    } catch (error) {
      this.#fatal(error);
    }
  }

  #fatal(error: unknown): void {
    if (this.#destroyed) return;
    const closeCode = isMoqtProtocolError(error) ? error.code : SESSION_ERROR.INTERNAL_ERROR;
    try {
      this.#transport.close({ closeCode, reason: error instanceof Error ? error.message : 'session error' });
    } catch {
      // transport already gone
    }
    this.#handleClosed(error);
  }

  #handleClosed(error: unknown, { expected = false }: { expected?: boolean } = {}): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (!this.#receivedServerSetup) {
      this.#rejectReady(error ?? new MoqtProtocolError('session closed before server SETUP'));
    }
    for (const track of this.#tracks.values()) {
      this.#settlePublish(track.publish);
      track.publish.stream?.cancel(error);
      for (const subscriber of track.subscribers) void subscriber.cancel();
    }
    this.#tracks.clear();
    this.#controlWriter = undefined;
    // Request timeouts guard responses that can no longer arrive — no
    // timer may outlive the session.
    for (const timer of this.#pendingTimers) clearTimeout(timer);
    this.#pendingTimers.clear();

    // Mirror the subscribe driver: a transport that drops before server
    // SETUP is a session failure even when the close itself was clean.
    const closeError =
      error ??
      (expected || this.#receivedServerSetup ? undefined : new MoqtProtocolError('session closed before server SETUP'));
    this.#callbacks.onClosed?.(closeError === undefined ? {} : { error: closeError });
  }

  close(closeCode = SESSION_ERROR.NO_ERROR, reason = ''): void {
    if (this.#destroyed || this.#closing) return;
    this.#closing = true;
    void this.#drainAndClose(closeCode, reason);
  }

  /**
   * Orderly close: closing the transport discards queued data (WebTransport
   * semantics), so the PUBLISH_DONE / GOAWAY control writes must be given a
   * bounded window to land first — a real relay should observe every
   * track's PUBLISH_DONE, not an abrupt transport end.
   */
  async #drainAndClose(closeCode: number, reason: string): Promise<void> {
    // One macrotask beat before the last-resort sweep below: track owners
    // tearing down in the same reactive flush (`setupTrackPublishers`'s
    // cleanup runs on a microtask after ours on the unpublish path) get to
    // send PUBLISH_DONE themselves, with the real per-track stream count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.#destroyed) return;
    for (const track of this.#tracks.values()) {
      this.#finishTrack(track, PUBLISH_DONE_STATUS.TRACK_ENDED, 0, '');
    }
    // GOAWAY tells the peer to stop routing new requests to us. Clients
    // may send it too — with a zero-length New Session URI (§10.4, same
    // as the subscribe driver's close()).
    const writes: Promise<unknown>[] = [...this.#tracks.values()].map(
      (track) => track.doneFlushed ?? Promise.resolve()
    );
    writes.push(this.#controlWriter?.write(encodeGoaway(0)).catch(() => {}) ?? Promise.resolve());

    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(writes),
        new Promise<void>((resolve) => {
          flushTimer = setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
    }

    if (this.#destroyed) return;
    try {
      this.#transport.close({ closeCode, reason });
    } catch {
      // transport already gone
    }
    this.#handleClosed(undefined, { expected: true });
  }

  destroy(): void {
    this.close();
  }

  // ---------------------------------------------------------------------------
  // Publisher-initiated requests
  // ---------------------------------------------------------------------------

  #allocateRequestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 2;
    return id;
  }

  #settlePublish(record: PublishRecord): void {
    // The response timers themselves are session-owned (`#pendingTimers`,
    // cleared by `#openRequest`'s settle paths and on close).
    record.settled = true;
  }

  /** Open a request stream, bind the response timeout, and route messages. */
  #openRequest(
    message: Uint8Array,
    onMessage: (message: ControlMessage) => void,
    onFailure: (failure: PublishRequestFailure) => void,
    bind?: (stream: RequestStream) => void
  ): void {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      this.#pendingTimers.delete(timer);
      timer = undefined;
    };
    const fail = (failure: PublishRequestFailure): void => {
      if (settled || this.#destroyed) return;
      settled = true;
      clearTimer();
      onFailure(failure);
    };
    const settle = (): void => {
      settled = true;
      clearTimer();
    };

    void (async () => {
      let stream: BidirectionalStreamLike;
      try {
        stream = await this.#transport.createBidirectionalStream();
      } catch (error) {
        fail({
          errorCode: REQUEST_ERROR_CODE.INTERNAL_ERROR,
          retryInterval: 0,
          reason: error instanceof Error ? error.message : 'failed to open request stream',
        });
        if (!this.#destroyed) this.#fatal(error);
        return;
      }

      let requestStream: RequestStream | undefined;
      const timeout = this.#config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      if (timeout > 0 && !this.#destroyed) {
        timer = setTimeout(() => {
          const failure = {
            errorCode: REQUEST_ERROR_CODE.TIMEOUT,
            retryInterval: 0,
            reason: 'no response before the request timeout',
          };
          // The stream dies with the request (the subscribe driver's
          // timeout contract): left open, a late REQUEST_OK would fire
          // onMessage after the failure and report a second, contradictory
          // result for a request already reported dead.
          requestStream?.cancel(failure);
          fail(failure);
        }, timeout);
        this.#pendingTimers.add(timer);
      }

      requestStream = openRequestStream(stream, message, {
        onMessage: (msg) => {
          if (msg.kind === 'request-ok' || msg.kind === 'request-error') settle();
          onMessage(msg);
        },
        onFin: () =>
          fail({
            errorCode: REQUEST_ERROR_CODE.INTERNAL_ERROR,
            retryInterval: 0,
            reason: 'request stream closed before a response',
          }),
        onError: (error) => {
          if (isMoqtProtocolError(error)) {
            this.#fatal(error);
            return;
          }
          fail({
            errorCode: REQUEST_ERROR_CODE.INTERNAL_ERROR,
            retryInterval: 0,
            reason: error instanceof Error ? error.message : 'request stream failed',
          });
        },
      });
      bind?.(requestStream);
      if (this.#destroyed) requestStream.cancel();
    })();
  }

  publishNamespace(trackNamespace: TrackNamespace, parameters?: MessageParameters): void {
    if (this.#destroyed) return;
    const requestId = this.#allocateRequestId();
    const message = encodePublishNamespace({ requestId, trackNamespace, parameters });
    this.#openRequest(
      message,
      (msg) => {
        switch (msg.kind) {
          case 'request-ok':
            this.#callbacks.onNamespaceResult?.({ accepted: true });
            break;
          case 'request-error':
            this.#callbacks.onNamespaceResult?.({ accepted: false, error: msg });
            break;
          case 'goaway':
            this.#callbacks.onGoaway?.(msg);
            break;
          default:
            this.#fatal(new MoqtProtocolError(`unexpected ${msg.kind} on a publish-namespace request stream`));
        }
      },
      (failure) => this.#callbacks.onNamespaceResult?.({ accepted: false, error: failure })
    );
  }

  publishTrack(options: PublishTrackOptions): PublishedTrack {
    const requestId = this.#allocateRequestId();
    const trackAlias = this.#nextTrackAlias++;
    if (this.#destroyed || this.#closing) {
      // Same guard as publishNamespace(): a closed session must not
      // repopulate `#tracks` or open request streams — hand back an inert
      // handle so late callers still get the PublishedTrack shape.
      return { requestId, trackAlias, trackName: options.trackName, done: () => {} };
    }
    const record: PublishRecord = {
      requestId,
      trackName: options.trackName,
      trackAlias,
      settled: false,
      doneSent: false,
    };
    const track: TrackRecord = {
      key: trackKey(options.trackNamespace, options.trackName),
      trackAlias,
      publish: record,
      subscribers: [],
      done: false,
    };
    this.#tracks.set(track.key, track);

    const message = encodePublish({
      requestId,
      trackNamespace: options.trackNamespace,
      trackName: options.trackName,
      trackAlias,
      parameters: options.parameters,
    });

    this.#openRequest(
      message,
      (msg) => {
        switch (msg.kind) {
          case 'request-ok':
            this.#settlePublish(record);
            this.#callbacks.onPublishResult?.({ trackName: record.trackName, trackAlias, accepted: true });
            break;
          case 'request-error':
            this.#settlePublish(record);
            this.#tracks.delete(track.key);
            this.#callbacks.onPublishResult?.({ trackName: record.trackName, trackAlias, accepted: false, error: msg });
            break;
          case 'request-update':
            this.#callbacks.onRequestUpdate?.({ requestId: msg.requestId, parameters: msg.parameters });
            break;
          case 'goaway':
            this.#callbacks.onGoaway?.(msg);
            break;
          default:
            this.#fatal(new MoqtProtocolError(`unexpected ${msg.kind} on a publish request stream`));
        }
      },
      (failure) => {
        this.#tracks.delete(track.key);
        this.#callbacks.onPublishResult?.({ trackName: record.trackName, trackAlias, accepted: false, error: failure });
      },
      (stream) => {
        record.stream = stream;
      }
    );

    return {
      requestId,
      trackAlias,
      trackName: options.trackName,
      done: (statusCode = PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount = 0, reason = '') => {
        this.#finishTrack(track, statusCode, streamCount, reason);
      },
    };
  }

  /**
   * PUBLISH_DONE + FIN on every stream carrying this track's request state.
   * The aggregated write completion lands on `track.doneFlushed` so
   * `close()` can hold the transport open until the messages reach the wire.
   */
  #finishTrack(track: TrackRecord, statusCode: number, streamCount: number, reason: string): void {
    if (track.done) return;
    track.done = true;
    const writes: Promise<void>[] = [];
    const done = encodePublishDone(statusCode, streamCount, reason);
    const publish = track.publish;
    if (publish.stream && !publish.doneSent) {
      publish.doneSent = true;
      writes.push(
        publish.stream
          .send(done)
          .then(() => publish.stream?.finWrite())
          .catch(() => {})
      );
    }
    for (const subscriber of track.subscribers) {
      if (subscriber.finished) continue;
      subscriber.finished = true;
      writes.push(
        subscriber
          .send(done)
          .then(() => subscriber.fin())
          .catch(() => {})
      );
    }
    track.doneFlushed = Promise.all(writes).then(() => {});
  }

  openUniStream(): Promise<WritableStream<Uint8Array>> {
    // Refuse rather than touch the transport once the session is going
    // away. Encoders keep producing frames for a beat after a peer kills
    // the session, and hammering createUnidirectionalStream() on a
    // torn-down WebTransport segfaults Chromium's renderer (null deref in
    // the native session teardown race) — observed against a relay that
    // resets every stream on protocol disagreement.
    if (this.#destroyed || this.#closing) {
      return Promise.reject(new Error('moq publish session: closed'));
    }
    return this.#transport.createUnidirectionalStream();
  }

  // ---------------------------------------------------------------------------
  // Incoming unidirectional streams (control, padding)
  // ---------------------------------------------------------------------------

  async #acceptUnidirectionalStreams(): Promise<void> {
    const reader = this.#transport.incomingUnidirectionalStreams.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        void this.#handleUnidirectionalStream(value).catch((error) => {
          if (isMoqtProtocolError(error)) this.#fatal(error);
        });
      }
    } catch {
      // Transport went away; `closed` handles the surfacing.
    } finally {
      reader.releaseLock();
    }
  }

  async #handleUnidirectionalStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new StreamReader(stream);
    const streamType = await reader.readVarint();

    if (streamType === STREAM_TYPE.SETUP) {
      await this.#runControlStream(reader);
      return;
    }
    if (streamType === STREAM_TYPE.PADDING) {
      await reader.cancel();
      return;
    }
    await reader.cancel();
    if (isSubgroupHeaderType(streamType) || streamType === STREAM_TYPE.FETCH_HEADER) {
      throw new MoqtProtocolError('publish session received a data stream');
    }
    throw new MoqtProtocolError(`unknown unidirectional stream type 0x${streamType.toString(16)}`);
  }

  /** Read one control-message frame using the pull-based stream reader. */
  async #readControlFrame(reader: StreamReader, type: number): Promise<ControlMessage> {
    const high = await reader.readUint8();
    const low = await reader.readUint8();
    const body = await reader.readBytes(high * 256 + low);
    return decodeControlMessage({ type, body });
  }

  async #runControlStream(reader: StreamReader): Promise<void> {
    // The stream-type varint (0x2F00) doubles as the first message's type.
    const setup = await this.#readControlFrame(reader, MESSAGE_TYPE.SETUP);
    if (setup.kind !== 'setup') {
      throw new MoqtProtocolError('control stream did not begin with SETUP');
    }
    if (this.#receivedServerSetup) {
      throw new MoqtProtocolError('received a second control stream');
    }
    this.#receivedServerSetup = true;
    this.#resolveReady();
    this.#callbacks.onReady?.(setup.options);

    while (!(await reader.atEnd())) {
      const type = await reader.readVarint();
      const message = await this.#readControlFrame(reader, type);
      if (message.kind !== 'goaway') {
        throw new MoqtProtocolError(`unexpected ${message.kind} on the control stream`);
      }
      if (this.#receivedControlGoaway) {
        throw new MoqtProtocolError('received more than one GOAWAY on the control stream');
      }
      this.#receivedControlGoaway = true;
      this.#callbacks.onGoaway?.(message);
    }
    // A closed control stream ends the session (§3.3).
    if (!this.#destroyed) {
      this.#fatal(new MoqtProtocolError('peer closed its control stream'));
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming bidirectional streams (peer-initiated requests — SUBSCRIBE)
  // ---------------------------------------------------------------------------

  async #acceptBidirectionalStreams(): Promise<void> {
    const reader = this.#transport.incomingBidirectionalStreams.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        void this.#handleIncomingRequest(value).catch((error) => {
          if (isMoqtProtocolError(error)) this.#fatal(error);
        });
      }
    } catch {
      // Transport went away.
    } finally {
      reader.releaseLock();
    }
  }

  async #handleIncomingRequest(stream: BidirectionalStreamLike): Promise<void> {
    const reader = new StreamReader(stream.readable);
    const type = await reader.readVarint();
    const message = await this.#readControlFrame(reader, type);

    if (message.kind === 'subscribe') {
      await this.#handleIncomingSubscribe(stream, reader, message);
      return;
    }

    // Everything else: this endpoint only serves its own published tracks.
    const respond = async (bytes: Uint8Array) => {
      const writer = stream.writable.getWriter();
      try {
        await writer.write(bytes);
        await writer.close();
      } catch {
        // Peer cancelled; nothing to clean up.
      }
      await reader.cancel();
    };
    const errorCode = message.kind === 'publish' ? REQUEST_ERROR_CODE.UNINTERESTED : REQUEST_ERROR_CODE.NOT_SUPPORTED;
    await respond(encodeRequestError(errorCode, 'publish-only endpoint'));
  }

  async #handleIncomingSubscribe(
    stream: BidirectionalStreamLike,
    reader: StreamReader,
    subscribe: Extract<ControlMessage, { kind: 'subscribe' }>
  ): Promise<void> {
    const track = this.#tracks.get(trackKey(subscribe.trackNamespace, subscribe.trackName));
    const writer = stream.writable.getWriter();

    if (!track || track.done) {
      try {
        await writer.write(encodeRequestError(REQUEST_ERROR_CODE.DOES_NOT_EXIST, 'unknown track'));
        await writer.close();
      } catch {
        // Peer cancelled.
      }
      await reader.cancel();
      return;
    }

    const subscriber: SubscriberStream = {
      requestId: subscribe.requestId,
      send: (bytes) => writer.write(bytes),
      fin: () => writer.close(),
      cancel: async () => {
        subscriber.finished = true;
        writer.abort().catch(() => {});
        try {
          await reader.cancel();
        } catch {
          // The stream already errored (e.g. the peer reset it first).
        }
      },
      finished: false,
    };
    track.subscribers.push(subscriber);

    try {
      await writer.write(encodeSubscribeOk(track.trackAlias));
    } catch {
      // Peer cancelled before the response landed.
      track.subscribers = track.subscribers.filter((s) => s !== subscriber);
      await reader.cancel();
      return;
    }
    this.#callbacks.onSubscribe?.(subscribe);

    // Keep serving the request stream: REQUEST_UPDATEs arrive here.
    try {
      while (!(await reader.atEnd())) {
        const type = await reader.readVarint();
        const message = await this.#readControlFrame(reader, type);
        if (message.kind === 'request-update') {
          this.#callbacks.onRequestUpdate?.({ requestId: message.requestId, parameters: message.parameters });
        } else if (message.kind === 'goaway') {
          this.#callbacks.onGoaway?.(message);
        } else {
          throw new MoqtProtocolError(`unexpected ${message.kind} on an incoming subscribe stream`);
        }
      }
    } catch (error) {
      if (isMoqtProtocolError(error)) throw error;
      // Reset — the subscriber cancelled (§3.3.3); ordinary end-of-request.
    } finally {
      track.subscribers = track.subscribers.filter((s) => s !== subscriber);
      if (!this.#destroyed) this.#callbacks.onSubscribeEnd?.({ requestId: subscribe.requestId });
    }
  }
}

/**
 * Create a publish-capable MOQT session driver over an established
 * transport.
 *
 * @example
 * ```ts
 * const session = createMoqtPublishSession(transport, {
 *   callbacks: { onPublishResult: (r) => r.accepted && startWriting(r.trackAlias) },
 * });
 * await session.ready;
 * session.publishNamespace(['live', 'abc123']);
 * const track = session.publishTrack({ trackNamespace: ['live', 'abc123'], trackName: 'video' });
 * ```
 */
export function createMoqtPublishSession(
  transport: MoqtTransport,
  config: MoqtPublishSessionConfig = {}
): MoqtPublishSession {
  return new MoqtPublishSessionImpl(transport, config);
}

// =============================================================================
// Session actor — connect + drive the driver, reactive snapshot for behaviors
// =============================================================================

/** Where to publish: a MoQ relay endpoint plus the track namespace. */
export interface PublishEndpoint {
  url: string;
  namespace: string[];
  /**
   * Relay auth token, sent as a `?jwt=` query parameter on the connect
   * URL — the only carriage the known relay fleet (moq-lite-rs lineage)
   * accepts; see `authParameters` in the session actor for why the
   * draft-19 AUTHORIZATION_TOKEN structures stay off the wire for now.
   */
  authToken?: string;
}

/**
 * Transport factory seam. The default constructs a real `WebTransport`
 * (mirroring the playback session actor's connect); tests and non-browser
 * hosts inject an in-memory or QUIC-backed transport.
 */
export type ConnectPublishTransport = (endpoint: PublishEndpoint) => {
  transport: MoqtTransport;
  ready: Promise<void>;
};

export type PublishSessionActorStatus = 'connecting' | 'ready' | 'live' | 'draining' | 'closed' | 'failed';

export interface PublishSessionActorContext {
  status: PublishSessionActorStatus;
  /** Present from `'ready'` on. */
  session?: MoqtPublishSession;
  /** Set when the server announced migration. */
  goaway?: Goaway;
  error?: unknown;
  /** PUBLISH offers the peer accepted. */
  publishedTracks: number;
  /** Live inbound subscriptions across the published tracks. */
  subscriberCount: number;
}

type SessionMessage =
  | { type: 'connected'; session: MoqtPublishSession }
  | { type: 'published' }
  | { type: 'publish-rejected'; error: unknown }
  | { type: 'subscribed' }
  | { type: 'unsubscribed' }
  | { type: 'goaway'; goaway: Goaway }
  | { type: 'closed' }
  | { type: 'failed'; error: unknown };

export interface CreatePublishSessionActorOptions {
  endpoint: PublishEndpoint;
  connectTransport?: ConnectPublishTransport;
  /** Forwarded to the session driver. */
  requestTimeoutMs?: number;
  implementationName?: string;
}

export interface PublishSessionActor
  extends Pick<TransitionActor<PublishSessionActorContext, SessionMessage>, 'snapshot'> {
  /** Request parameters carrying the endpoint's auth token, when one exists. */
  getAuthParameters(): MessageParameters;
  destroy(): void;
}

/**
 * Compose the WebTransport connect URL for an endpoint. moq-lite-rs
 * lineage relays (Mux's relay-rs fleet, the Varnish lab relays)
 * authenticate with a JWT `?jwt=` query parameter on the connect URL and
 * close the connection right after CLIENT_SETUP when auth is required
 * but missing. An explicit `jwt` param already in the endpoint URL wins,
 * and an unparseable URL is returned verbatim so `new WebTransport(url)`
 * raises the canonical error.
 */
export function composePublishConnectUrl(url: string, authToken?: string): string {
  if (!authToken) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('jwt')) return url;
    parsed.searchParams.set('jwt', authToken);
    return parsed.href;
  } catch {
    return url;
  }
}

function connectWebTransport(endpoint: PublishEndpoint): { transport: MoqtTransport; ready: Promise<void> } {
  const transport = new WebTransport(composePublishConnectUrl(endpoint.url, endpoint.authToken), {
    protocols: [MOQT_PROTOCOL_ID],
  });
  return { transport, ready: transport.ready.then(() => undefined) };
}

/**
 * Connect to the endpoint's relay and drive the publish-session lifecycle:
 * `'connecting'` → `'ready'` (SETUP complete, namespace announced) →
 * `'live'` (first PUBLISH accepted). GOAWAY moves a live session to
 * `'draining'`; `destroy()` sends PUBLISH_DONE for every still-live track,
 * lets the control writes drain briefly, then closes the transport (the
 * driver's `close()` contract). The connection starts immediately —
 * composition-level gating belongs to the behavior that creates this
 * actor (`open-publish-session`).
 */
export function createPublishSessionActor(options: CreatePublishSessionActorOptions): PublishSessionActor {
  const { endpoint } = options;
  const connectTransport = options.connectTransport ?? connectWebTransport;

  let destroyed = false;
  let session: MoqtPublishSession | undefined;

  const inner = createTransitionActor<PublishSessionActorContext, SessionMessage>(
    { status: 'connecting', publishedTracks: 0, subscriberCount: 0 },
    (context, message) => {
      // Terminal states are sticky: a transport-closed callback after a
      // failure must not soften 'failed' back to 'closed'.
      if (context.status === 'closed' || context.status === 'failed') return context;
      switch (message.type) {
        case 'connected':
          return { ...context, status: 'ready', session: message.session };
        case 'published': {
          const status = context.status === 'ready' ? 'live' : context.status;
          return { ...context, status, publishedTracks: context.publishedTracks + 1 };
        }
        case 'publish-rejected':
          return { ...context, status: 'failed', error: message.error };
        case 'subscribed':
          return { ...context, subscriberCount: context.subscriberCount + 1 };
        case 'unsubscribed':
          return { ...context, subscriberCount: Math.max(0, context.subscriberCount - 1) };
        case 'goaway':
          return { ...context, status: 'draining', goaway: message.goaway };
        case 'closed':
          return { ...context, status: 'closed' };
        case 'failed':
          return { ...context, status: 'failed', error: message.error };
      }
    }
  );

  // The endpoint token rides ONLY in the connect URL's `?jwt=` query
  // parameter (`composePublishConnectUrl`). The known relay fleet
  // (kixelated-lineage moq-lite-rs, incl. Mux's relay-rs deployments)
  // does not support draft-19 AUTHORIZATION_TOKEN structures yet and
  // hard-closes the session (`5 "invalid value"`) when one appears in a
  // request's parameters — verified against sjc.relay.mux.global: the
  // same PUBLISH_NAMESPACE gets REQUEST_OK bare and a session kill with
  // the parameter attached. Re-attach via this seam (encodeAuthTokenUseValue,
  // §10.2.2) once relays accept draft-19 auth.
  const authParameters = (): MessageParameters => ({});

  const start = async () => {
    let transport: MoqtTransport | undefined;
    try {
      const created = connectTransport(endpoint);
      transport = created.transport;
      await created.ready;
      if (destroyed) {
        transport.close();
        return;
      }
      session = createMoqtPublishSession(transport, {
        requestTimeoutMs: options.requestTimeoutMs,
        implementationName: options.implementationName,
        callbacks: {
          onGoaway: (goaway) => inner.send({ type: 'goaway', goaway }),
          onPublishResult: (result) => {
            if (result.accepted) {
              inner.send({ type: 'published' });
            } else {
              inner.send({
                type: 'publish-rejected',
                error: new MoqtProtocolError(
                  `PUBLISH of ${result.trackName} rejected: ${result.error?.reason ?? 'unknown error'} (code ${result.error?.errorCode ?? '?'})`
                ),
              });
            }
          },
          onSubscribe: () => inner.send({ type: 'subscribed' }),
          onSubscribeEnd: () => inner.send({ type: 'unsubscribed' }),
          onClosed: ({ error }) => {
            inner.send(error === undefined ? { type: 'closed' } : { type: 'failed', error });
          },
        },
      });
      await session.ready;
      if (destroyed) return;
      // Advisory announce — a rejection is reported by the driver's
      // callback but never blocks the PUBLISH flow (see the module doc).
      session.publishNamespace(endpoint.namespace, authParameters());
      inner.send({ type: 'connected', session });
    } catch (error) {
      if (session) {
        session.destroy();
      } else {
        try {
          transport?.close();
        } catch {
          // an already-failed transport throws on close()
        }
      }
      if (!destroyed) inner.send({ type: 'failed', error });
    }
  };
  void start();

  return {
    get snapshot() {
      return inner.snapshot;
    },

    getAuthParameters: authParameters,

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      session?.destroy();
      inner.destroy();
    },
  };
}
