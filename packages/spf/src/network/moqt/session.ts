/**
 * Pure MOQT session protocol driver (moq-transport draft-19), subscribe
 * side only.
 *
 * Owns the protocol mechanics over an established transport: the SETUP
 * exchange on paired unidirectional control streams (§3.3), request-stream
 * bookkeeping keyed by Request ID (§10.1 — client IDs are even, starting
 * at 0), routing of incoming data streams to subscriptions (by Track
 * Alias) and fetches (by Request ID), GOAWAY handling, and session
 * termination.
 *
 * Deliberately callback-shaped with NO signals (like
 * `onMediaSourceReadyStateChange`) — signal awareness enters at the
 * `playback/` layer, where the moq-session actor binds these callbacks to
 * SPF state. The transport is a structural subset of `WebTransport`, so
 * tests drive the driver with an in-memory fake and the DOM layer passes a
 * real `WebTransport` unchanged.
 *
 * Version negotiation happens at connection time (ALPN /
 * `WT-Available-Protocols`, `MOQT_PROTOCOL_ID`), before this driver sees
 * the transport.
 *
 * Datagram reception is not implemented: MSF maps every object to its own
 * stream, so a subscribe-only MSF engine never legitimately receives
 * OBJECT_DATAGRAMs.
 */
import { StreamReader, utf8Encode } from './bytes';
import {
  type ControlMessage,
  decodeControlMessage,
  encodeFetch,
  encodeGoaway,
  encodeRequestError,
  encodeRequestOk,
  encodeRequestUpdate,
  encodeSetup,
  encodeSubscribe,
  encodeTrackStatus,
  type FetchRequest,
  type KeyValuePair,
  MESSAGE_TYPE,
  type MessageParameters,
  REQUEST_ERROR_CODE,
  type Redirect,
  SETUP_OPTION,
  type TrackNamespace,
} from './control-messages';
import { isMoqtProtocolError, MoqtProtocolError, SESSION_ERROR } from './errors';
import {
  type FetchStreamEntry,
  isSubgroupHeaderType,
  type MoqtObject,
  readFetchEntries,
  readFetchHeader,
  readSubgroupHeader,
  readSubgroupObjects,
  STREAM_TYPE,
  type SubgroupHeader,
} from './object-stream';
import { type BidirectionalStreamLike, openRequestStream, type RequestStream } from './request-stream';

// ============================================================================
// Transport seam
// ============================================================================

/**
 * Structural subset of `WebTransport` the session driver needs. A real
 * `WebTransport` instance satisfies this; tests provide an in-memory fake
 * (the same seam pattern as SPF's fetch injection).
 */
export interface MoqtTransport {
  readonly incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  readonly incomingBidirectionalStreams: ReadableStream<BidirectionalStreamLike>;
  createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
  createBidirectionalStream(): Promise<BidirectionalStreamLike>;
  close(closeInfo?: { closeCode?: number; reason?: string }): void;
  readonly closed: Promise<unknown>;
}

// ============================================================================
// Public session surface
// ============================================================================

export interface RequestError {
  errorCode: number;
  retryInterval: number;
  reason: string;
  redirect?: Redirect;
}

export interface SubscribeOk {
  trackAlias: number;
  parameters: MessageParameters;
  trackProperties: KeyValuePair[];
}

export interface PublishDone {
  statusCode: number;
  streamCount: number;
  reason: string;
}

export interface SubscriptionHandlers {
  onOk?(ok: SubscribeOk): void;
  onError?(error: RequestError): void;
  onObject?(object: MoqtObject): void;
  /** A subgroup stream finished cleanly (FIN). */
  onSubgroupEnd?(info: { groupId: number; subgroupId: number; endOfGroup: boolean }): void;
  /** A subgroup stream was reset — objects from it may be missing. */
  onSubgroupReset?(info: { groupId: number; error: unknown }): void;
  onDone?(done: PublishDone): void;
  /** Response to a REQUEST_UPDATE sent on this subscription. */
  onUpdateOk?(): void;
  /** GOAWAY on this request stream: re-issue the request (possibly elsewhere). */
  onGoaway?(goaway: Goaway): void;
}

export interface Subscription {
  readonly requestId: number;
  /** Modify the subscription (REQUEST_UPDATE, §10.9). */
  update(parameters: MessageParameters): void;
  /**
   * Tear the subscription down. Draft-19 has no UNSUBSCRIBE message —
   * teardown is the request stream's lifecycle (§3.3.3).
   */
  cancel(reason?: unknown): void;
}

export interface FetchOk {
  endOfTrack: boolean;
  endLocation: { group: number; object: number };
  parameters: MessageParameters;
  trackProperties: KeyValuePair[];
}

export interface FetchHandlers {
  onOk?(ok: FetchOk): void;
  onError?(error: RequestError): void;
  onEntry?(entry: FetchStreamEntry): void;
  /** The fetch data stream finished cleanly (FIN). */
  onEnd?(): void;
  onGoaway?(goaway: Goaway): void;
}

export interface FetchHandle {
  readonly requestId: number;
  cancel(reason?: unknown): void;
}

export interface TrackStatusHandlers {
  onOk?(status: { parameters: MessageParameters; trackProperties: KeyValuePair[] }): void;
  onError?(error: RequestError): void;
}

export interface Goaway {
  newSessionUri: string;
  timeout: number;
}

export interface IncomingPublish {
  requestId: number;
  trackNamespace: TrackNamespace;
  trackName: string;
  trackAlias: number;
  parameters: MessageParameters;
}

export interface MoqtSessionCallbacks {
  /** The server's SETUP arrived; the session is fully established. */
  onReady?(serverOptions: KeyValuePair[]): void;
  /** GOAWAY on the control stream: stop initiating requests, migrate. */
  onGoaway?(goaway: Goaway): void;
  /**
   * A server-initiated PUBLISH arrived. Call exactly one of the responders.
   * Absent, the session rejects with UNINTERESTED (a subscribe-only client).
   */
  onIncomingPublish?(
    publish: IncomingPublish,
    respond: { accept(parameters?: MessageParameters): void; reject(errorCode?: number, reason?: string): void }
  ): void;
  /** The session ended — transport closed, or a fatal protocol error. */
  onClosed?(info: { error?: unknown }): void;
}

export interface MoqtSessionConfig {
  /** Extra Setup Options to send (an implementation identifier is added automatically). */
  setupOptions?: KeyValuePair[];
  /** Identifies this implementation in SETUP (§10.3.1.5). */
  implementationName?: string;
  /**
   * How long to hold an incoming data stream whose Track Alias has no
   * registered subscription yet (objects can outrace SUBSCRIBE_OK). §11.4.2
   * allows brief buffering; expired streams are dropped. Default 2000ms.
   */
  unknownAliasTimeoutMs?: number;
  callbacks?: MoqtSessionCallbacks;
}

export interface MoqtSubscribeOptions {
  trackNamespace: TrackNamespace;
  trackName: string;
  parameters?: MessageParameters;
}

/** A joining fetch omits namespace/name — they come from the joined subscription. */
export type MoqtFetchOptions =
  | {
      type: 'standalone';
      trackNamespace: TrackNamespace;
      trackName: string;
      startLocation: { group: number; object: number };
      endLocation: { group: number; object: number };
      parameters?: MessageParameters;
    }
  | {
      type: 'relative-joining' | 'absolute-joining';
      joiningRequestId: number;
      joiningStart: number;
      parameters?: MessageParameters;
    };

export interface MoqtSession {
  /** Resolves when the server's SETUP has been received. */
  readonly ready: Promise<void>;
  subscribe(options: MoqtSubscribeOptions, handlers?: SubscriptionHandlers): Subscription;
  fetch(options: MoqtFetchOptions, handlers?: FetchHandlers): FetchHandle;
  trackStatus(options: MoqtSubscribeOptions, handlers?: TrackStatusHandlers): void;
  /** Send GOAWAY then close the transport session. */
  close(closeCode?: number, reason?: string): void;
  destroy(): void;
}

const DEFAULT_UNKNOWN_ALIAS_TIMEOUT_MS = 2000;
const DEFAULT_IMPLEMENTATION_NAME = '@videojs/spf moqt';

// ============================================================================
// Internal records
// ============================================================================

interface SubscriptionRecord {
  requestId: number;
  handlers: SubscriptionHandlers;
  stream?: RequestStream;
  trackAlias?: number;
  cancelled: boolean;
  pendingCancelReason?: unknown;
}

interface FetchRecord {
  requestId: number;
  handlers: FetchHandlers;
  stream?: RequestStream;
  groupOrder: 'ascending' | 'descending';
  cancelled: boolean;
  pendingCancelReason?: unknown;
}

interface AliasWaiter {
  resolve(record: SubscriptionRecord | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// Session driver
// ============================================================================

class MoqtSessionImpl implements MoqtSession {
  readonly ready: Promise<void>;

  #transport: MoqtTransport;
  #config: MoqtSessionConfig;
  #callbacks: MoqtSessionCallbacks;

  #nextRequestId = 0; // client request IDs: even, starting at 0 (§10.1)
  #subscriptions = new Map<number, SubscriptionRecord>();
  #fetches = new Map<number, FetchRecord>();
  #aliasRoutes = new Map<number, SubscriptionRecord>();
  #aliasWaiters = new Map<number, AliasWaiter[]>();

  #resolveReady!: () => void;
  #controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #receivedServerSetup = false;
  #receivedControlGoaway = false;
  #destroyed = false;

  constructor(transport: MoqtTransport, config: MoqtSessionConfig = {}) {
    this.#transport = transport;
    this.#config = config;
    this.#callbacks = config.callbacks ?? {};
    this.ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });

    void this.#start();
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async #start(): Promise<void> {
    // Accept loops start first: the peer's streams must be processed even
    // while our own SETUP write is still propagating (either peer may send
    // stream data first, §3.3).
    void this.#acceptUnidirectionalStreams();
    void this.#acceptBidirectionalStreams();
    void this.#transport.closed.then(
      () => this.#handleClosed(undefined),
      (error) => this.#handleClosed(error)
    );

    try {
      const control = await this.#transport.createUnidirectionalStream();
      this.#controlWriter = control.getWriter();
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

  #handleClosed(error: unknown): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const waiters of this.#aliasWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
    }
    this.#aliasWaiters.clear();
    this.#callbacks.onClosed?.(error === undefined ? {} : { error });
  }

  close(closeCode = SESSION_ERROR.NO_ERROR, reason = ''): void {
    if (this.#destroyed) return;
    // Best-effort GOAWAY so the peer can stop routing to us first.
    this.#controlWriter?.write(encodeGoaway(0)).catch(() => {});
    try {
      this.#transport.close({ closeCode, reason });
    } catch {
      // transport already gone
    }
    this.#handleClosed(undefined);
  }

  destroy(): void {
    this.close();
  }

  // --------------------------------------------------------------------------
  // Requests
  // --------------------------------------------------------------------------

  #allocateRequestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 2;
    return id;
  }

  subscribe(options: MoqtSubscribeOptions, handlers: SubscriptionHandlers = {}): Subscription {
    const requestId = this.#allocateRequestId();
    const record: SubscriptionRecord = { requestId, handlers, cancelled: false };
    this.#subscriptions.set(requestId, record);

    const message = encodeSubscribe({
      requestId,
      trackNamespace: options.trackNamespace,
      trackName: options.trackName,
      parameters: options.parameters,
    });

    void this.#openRequest(message, record, (msg) => this.#handleSubscriptionMessage(record, msg));

    return {
      requestId,
      update: (parameters) => {
        record.stream?.send(encodeRequestUpdate(requestId, parameters)).catch(() => {});
      },
      cancel: (reason) => this.#cancelSubscription(record, reason),
    };
  }

  fetch(options: MoqtFetchOptions, handlers: FetchHandlers = {}): FetchHandle {
    const requestId = this.#allocateRequestId();
    const record: FetchRecord = {
      requestId,
      handlers,
      groupOrder: options.parameters?.groupOrder ?? 'ascending',
      cancelled: false,
    };
    this.#fetches.set(requestId, record);

    const request: FetchRequest =
      options.type === 'standalone'
        ? { requestId, ...options }
        : {
            requestId,
            type: options.type,
            joiningRequestId: options.joiningRequestId,
            joiningStart: options.joiningStart,
            parameters: options.parameters,
          };

    void this.#openRequest(encodeFetch(request), record, (msg) => this.#handleFetchMessage(record, msg));

    return {
      requestId,
      cancel: (reason) => this.#cancelFetch(record, reason),
    };
  }

  trackStatus(options: MoqtSubscribeOptions, handlers: TrackStatusHandlers = {}): void {
    const requestId = this.#allocateRequestId();
    const record = { cancelled: false } as { cancelled: boolean; stream?: RequestStream };

    const message = encodeTrackStatus({
      requestId,
      trackNamespace: options.trackNamespace,
      trackName: options.trackName,
      parameters: options.parameters,
    });

    void this.#openRequest(message, record, (msg) => {
      if (msg.kind === 'request-ok') {
        handlers.onOk?.({ parameters: msg.parameters, trackProperties: msg.trackProperties });
        record.stream?.finWrite().catch(() => {});
      } else if (msg.kind === 'request-error') {
        handlers.onError?.(msg);
        record.stream?.finWrite().catch(() => {});
      }
    });
  }

  async #openRequest(
    message: Uint8Array,
    record: { cancelled: boolean; pendingCancelReason?: unknown; stream?: RequestStream },
    onMessage: (message: ControlMessage) => void
  ): Promise<void> {
    let stream: BidirectionalStreamLike;
    try {
      stream = await this.#transport.createBidirectionalStream();
    } catch (error) {
      if (!this.#destroyed) this.#fatal(error);
      return;
    }
    record.stream = openRequestStream(stream, message, {
      onMessage,
      onError: (error) => {
        if (isMoqtProtocolError(error)) this.#fatal(error);
      },
    });
    // A cancel that raced the stream opening lands here.
    if (record.cancelled) record.stream.cancel(record.pendingCancelReason);
  }

  #handleSubscriptionMessage(record: SubscriptionRecord, message: ControlMessage): void {
    switch (message.kind) {
      case 'subscribe-ok': {
        if (record.trackAlias !== undefined && record.trackAlias !== message.trackAlias) {
          this.#fatal(new MoqtProtocolError('SUBSCRIBE_OK changed track alias'));
          return;
        }
        const existing = this.#aliasRoutes.get(message.trackAlias);
        if (existing && existing !== record) {
          this.#fatal(new MoqtProtocolError('duplicate track alias', SESSION_ERROR.DUPLICATE_TRACK_ALIAS));
          return;
        }
        record.trackAlias = message.trackAlias;
        this.#aliasRoutes.set(message.trackAlias, record);
        const waiters = this.#aliasWaiters.get(message.trackAlias);
        if (waiters) {
          this.#aliasWaiters.delete(message.trackAlias);
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
        record.handlers.onOk?.({
          trackAlias: message.trackAlias,
          parameters: message.parameters,
          trackProperties: message.trackProperties,
        });
        break;
      }
      case 'request-ok':
        record.handlers.onUpdateOk?.();
        break;
      case 'request-error':
        this.#removeSubscription(record);
        record.handlers.onError?.(message);
        break;
      case 'publish-done':
        // Data streams may still be inbound; the alias route stays until
        // the subscription is cancelled or the session ends, so late
        // subgroups still deliver (§10.11 leaves the timing policy to us).
        record.handlers.onDone?.(message);
        break;
      case 'goaway':
        record.handlers.onGoaway?.(message);
        break;
      default:
        this.#fatal(new MoqtProtocolError(`unexpected ${message.kind} on a subscribe request stream`));
    }
  }

  #handleFetchMessage(record: FetchRecord, message: ControlMessage): void {
    switch (message.kind) {
      case 'fetch-ok':
        record.handlers.onOk?.({
          endOfTrack: message.endOfTrack,
          endLocation: message.endLocation,
          parameters: message.parameters,
          trackProperties: message.trackProperties,
        });
        break;
      case 'request-error':
        this.#fetches.delete(record.requestId);
        record.handlers.onError?.(message);
        break;
      case 'goaway':
        record.handlers.onGoaway?.(message);
        break;
      default:
        this.#fatal(new MoqtProtocolError(`unexpected ${message.kind} on a fetch request stream`));
    }
  }

  #cancelSubscription(record: SubscriptionRecord, reason?: unknown): void {
    if (record.cancelled) return;
    record.cancelled = true;
    record.pendingCancelReason = reason;
    record.stream?.cancel(reason);
    this.#removeSubscription(record);
  }

  #removeSubscription(record: SubscriptionRecord): void {
    this.#subscriptions.delete(record.requestId);
    if (record.trackAlias !== undefined && this.#aliasRoutes.get(record.trackAlias) === record) {
      this.#aliasRoutes.delete(record.trackAlias);
    }
  }

  #cancelFetch(record: FetchRecord, reason?: unknown): void {
    if (record.cancelled) return;
    record.cancelled = true;
    record.pendingCancelReason = reason;
    record.stream?.cancel(reason);
    this.#fetches.delete(record.requestId);
  }

  // --------------------------------------------------------------------------
  // Incoming unidirectional streams (control, subgroup, fetch, padding)
  // --------------------------------------------------------------------------

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
    if (isSubgroupHeaderType(streamType)) {
      const header = await readSubgroupHeader(reader, streamType);
      await this.#runSubgroupStream(reader, header);
      return;
    }
    if (streamType === STREAM_TYPE.FETCH_HEADER) {
      const { requestId } = await readFetchHeader(reader);
      await this.#runFetchStream(reader, requestId);
      return;
    }
    if (streamType === STREAM_TYPE.PADDING) {
      await reader.cancel();
      return;
    }
    await reader.cancel();
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

    // Subsequent control-stream messages: GOAWAY (at most once).
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

  /** Wait briefly for a subscription to claim `trackAlias` (§11.4.2 buffering). */
  #waitForAlias(trackAlias: number): Promise<SubscriptionRecord | undefined> {
    const known = this.#aliasRoutes.get(trackAlias);
    if (known || this.#destroyed) return Promise.resolve(known);
    return new Promise((resolve) => {
      const waiters = this.#aliasWaiters.get(trackAlias) ?? [];
      const timeout = this.#config.unknownAliasTimeoutMs ?? DEFAULT_UNKNOWN_ALIAS_TIMEOUT_MS;
      const waiter: AliasWaiter = {
        resolve,
        timer: setTimeout(() => {
          const remaining = this.#aliasWaiters.get(trackAlias)?.filter((w) => w !== waiter);
          if (remaining?.length) this.#aliasWaiters.set(trackAlias, remaining);
          else this.#aliasWaiters.delete(trackAlias);
          resolve(undefined);
        }, timeout),
      };
      waiters.push(waiter);
      this.#aliasWaiters.set(trackAlias, waiters);
    });
  }

  async #runSubgroupStream(reader: StreamReader, header: SubgroupHeader): Promise<void> {
    const record = await this.#waitForAlias(header.trackAlias);
    if (!record || record.cancelled) {
      await reader.cancel();
      return;
    }
    let lastSubgroupId = header.subgroupIdMode === 'explicit' ? header.subgroupId! : 0;
    try {
      for await (const object of readSubgroupObjects(reader, header)) {
        if (record.cancelled) {
          await reader.cancel();
          return;
        }
        lastSubgroupId = object.subgroupId;
        record.handlers.onObject?.(object);
      }
      record.handlers.onSubgroupEnd?.({
        groupId: header.groupId,
        subgroupId: lastSubgroupId,
        endOfGroup: header.endOfGroup,
      });
    } catch (error) {
      if (isMoqtProtocolError(error)) throw error;
      // A reset stream is a delivery event (timeout, cancellation), not a
      // session error — surface it to the subscription.
      record.handlers.onSubgroupReset?.({ groupId: header.groupId, error });
    }
  }

  async #runFetchStream(reader: StreamReader, requestId: number): Promise<void> {
    const record = this.#fetches.get(requestId);
    if (!record || record.cancelled) {
      await reader.cancel();
      return;
    }
    try {
      for await (const entry of readFetchEntries(reader, record.groupOrder)) {
        if (record.cancelled) {
          await reader.cancel();
          return;
        }
        record.handlers.onEntry?.(entry);
      }
      record.handlers.onEnd?.();
    } catch (error) {
      if (isMoqtProtocolError(error)) throw error;
      record.handlers.onEnd?.();
    }
  }

  // --------------------------------------------------------------------------
  // Incoming bidirectional streams (server-initiated requests)
  // --------------------------------------------------------------------------

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

    if (message.kind === 'publish') {
      const callbacks = this.#callbacks;
      if (callbacks.onIncomingPublish) {
        let responded = false;
        callbacks.onIncomingPublish(message, {
          accept: (parameters) => {
            if (responded) return;
            responded = true;
            void respond(encodeRequestOk(parameters ?? {}));
          },
          reject: (errorCode = REQUEST_ERROR_CODE.UNINTERESTED, reason = '') => {
            if (responded) return;
            responded = true;
            void respond(encodeRequestError(errorCode, reason));
          },
        });
        return;
      }
      await respond(encodeRequestError(REQUEST_ERROR_CODE.UNINTERESTED, 'subscribe-only client'));
      return;
    }

    // Any other server-initiated request: this client doesn't serve them.
    await respond(encodeRequestError(REQUEST_ERROR_CODE.NOT_SUPPORTED, 'subscribe-only client'));
  }
}

/**
 * Create a MOQT session driver over an established transport.
 *
 * @example
 * ```ts
 * const transport = new WebTransport(url, { protocols: [MOQT_PROTOCOL_ID] });
 * await transport.ready;
 * const session = createMoqtSession(transport, {
 *   callbacks: { onGoaway: (g) => migrate(g.newSessionUri) },
 * });
 * const subscription = session.subscribe(
 *   { trackNamespace: ['live', 'stream1'], trackName: 'catalog' },
 *   { onObject: (object) => handleCatalogObject(object) }
 * );
 * ```
 */
export function createMoqtSession(transport: MoqtTransport, config: MoqtSessionConfig = {}): MoqtSession {
  return new MoqtSessionImpl(transport, config);
}
