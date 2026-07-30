import { describe, expect, it, vi } from 'vitest';
import { ByteWriter, StreamReader, utf8Encode } from '../bytes';
import {
  type ControlMessage,
  ControlMessageDeframer,
  decodeControlMessage,
  encodePublishDone,
  encodePublishNamespace,
  encodeRequestError,
  encodeRequestOk,
  encodeSetup,
  encodeSubscribeOk,
  PUBLISH_DONE_STATUS,
  REQUEST_ERROR_CODE,
} from '../control-messages';
import type { MoqtObject } from '../object-stream';
import type { BidirectionalStreamLike } from '../request-stream';
import { createMoqtSession, type MoqtSessionCallbacks, type MoqtTransport } from '../session';

// ============================================================================
// In-memory transport fake — the same seam pattern as SPF's fetch injection.
// ============================================================================

interface PushChannel<T> {
  stream: ReadableStream<T>;
  push(value: T): void;
  close(): void;
}

function pushChannel<T>(): PushChannel<T> {
  let controller!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (value) => controller.enqueue(value),
    close: () => controller.close(),
  };
}

/** Server-side view of one client-initiated bidirectional stream. */
interface ServerRequestStream {
  /** Decoded control messages received from the client, in order. */
  messages: ControlMessage[];
  /** Resolves when the first client message has been decoded. */
  firstMessage: Promise<ControlMessage>;
  send(bytes: Uint8Array): Promise<void>;
  fin(): Promise<void>;
  reset(reason?: unknown): void;
}

function createFakeTransport() {
  const incomingUni = pushChannel<ReadableStream<Uint8Array>>();
  const incomingBidi = pushChannel<BidirectionalStreamLike>();
  const clientUniStreams: ReadableStream<Uint8Array>[] = [];
  const requestStreams: ServerRequestStream[] = [];
  const requestWaiters: ((stream: ServerRequestStream) => void)[] = [];
  let closeInfo: { closeCode?: number; reason?: string } | undefined;
  let resolveClosed!: (info: unknown) => void;
  const closed = new Promise<unknown>((resolve) => {
    resolveClosed = resolve;
  });

  const transport: MoqtTransport = {
    incomingUnidirectionalStreams: incomingUni.stream,
    incomingBidirectionalStreams: incomingBidi.stream,
    async createUnidirectionalStream() {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      clientUniStreams.push(pipe.readable);
      return pipe.writable;
    },
    async createBidirectionalStream() {
      const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
      const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
      const writer = serverToClient.writable.getWriter();

      const messages: ControlMessage[] = [];
      let resolveFirst!: (message: ControlMessage) => void;
      const firstMessage = new Promise<ControlMessage>((resolve) => {
        resolveFirst = resolve;
      });
      // Server-side read pump for the client's messages.
      void (async () => {
        const reader = clientToServer.readable.getReader();
        const deframer = new ControlMessageDeframer();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const frame of deframer.push(value)) {
              const message = decodeControlMessage(frame);
              messages.push(message);
              if (messages.length === 1) resolveFirst(message);
            }
          }
        } catch {
          // client reset its sending direction
        }
      })();

      const serverStream: ServerRequestStream = {
        messages,
        firstMessage,
        send: (bytes) => writer.write(bytes),
        fin: () => writer.close(),
        reset: (reason) => {
          writer.abort(reason).catch(() => {});
        },
      };
      requestStreams.push(serverStream);
      requestWaiters.shift()?.(serverStream);
      return { readable: serverToClient.readable, writable: clientToServer.writable };
    },
    close(info) {
      closeInfo = info;
      resolveClosed(info);
    },
    closed,
  };

  return {
    transport,
    /** The SETUP control stream the client opened (first client uni stream). */
    async clientControlStream(): Promise<StreamReader> {
      await vi.waitFor(() => {
        if (clientUniStreams.length === 0) throw new Error('no client uni stream yet');
      });
      return new StreamReader(clientUniStreams[0]!);
    },
    /** Wait for the next client-initiated request stream. */
    nextRequestStream(): Promise<ServerRequestStream> {
      const existing = requestStreams.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => requestWaiters.push(resolve));
    },
    /** Open the server's control stream and send its SETUP. */
    sendServerSetup(): void {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const writer = pipe.writable.getWriter();
      void writer.write(encodeSetup([]));
      incomingUni.push(pipe.readable);
    },
    /** Open a unidirectional data stream to the client. */
    openDataStream(bytes: Uint8Array): void {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const writer = pipe.writable.getWriter();
      void writer.write(bytes).then(() => writer.close());
      incomingUni.push(pipe.readable);
    },
    /** Open a unidirectional data stream the test writes to (and may reset). */
    openControlledDataStream(): { write(bytes: Uint8Array): Promise<void>; reset(error: unknown): void } {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      const writer = pipe.writable.getWriter();
      incomingUni.push(pipe.readable);
      return {
        write: (bytes) => writer.write(bytes),
        reset: (error) => {
          writer.abort(error).catch(() => {});
        },
      };
    },
    openIncomingBidi(bytes: Uint8Array): { responses: Promise<Uint8Array[]> } {
      const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
      const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
      const writer = serverToClient.writable.getWriter();
      void writer.write(bytes).then(() => writer.close());
      incomingBidi.push({ readable: serverToClient.readable, writable: clientToServer.writable });
      const responses = (async () => {
        const chunks: Uint8Array[] = [];
        const reader = clientToServer.readable.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        return chunks;
      })();
      return { responses };
    },
    getCloseInfo: () => closeInfo,
    /** Simulate a transport-side drop (peer/network close, not a local `close()`). */
    dropTransport: () => resolveClosed(undefined),
  };
}

/** Encode a one-object subgroup stream for `trackAlias` (type 0x38: subgroup 0, default priority, end-of-group). */
function encodeSubgroup(trackAlias: number, groupId: number, payload: Uint8Array, objectId = 0): Uint8Array {
  const writer = new ByteWriter();
  writer.writeVarint(0x38);
  writer.writeVarint(trackAlias);
  writer.writeVarint(groupId);
  writer.writeVarint(objectId); // first object id (absolute)
  writer.writeVarint(payload.length);
  writer.writeBytes(payload);
  return writer.toBytes();
}

function createSessionHarness(callbacks?: MoqtSessionCallbacks) {
  const fake = createFakeTransport();
  const session = createMoqtSession(fake.transport, { callbacks, unknownAliasTimeoutMs: 200 });
  return { ...fake, session };
}

describe('createMoqtSession', () => {
  it('sends SETUP on a fresh unidirectional control stream', async () => {
    const harness = createSessionHarness();
    const control = await harness.clientControlStream();
    const type = await control.readVarint();
    expect(type).toBe(0x2f00);
    const high = await control.readUint8();
    const low = await control.readUint8();
    const body = await control.readBytes(high * 256 + low);
    const setup = decodeControlMessage({ type, body });
    expect(setup.kind).toBe('setup');
    harness.session.destroy();
  });

  it('resolves ready and reports server options once the server SETUP arrives', async () => {
    const onReady = vi.fn();
    const harness = createSessionHarness({ onReady });
    harness.sendServerSetup();
    await harness.session.ready;
    expect(onReady).toHaveBeenCalledWith([]);
    harness.session.destroy();
  });

  it('subscribes on a new request stream and routes objects by track alias', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const onOk = vi.fn();
    const objects: MoqtObject[] = [];
    const subgroupEnds: unknown[] = [];
    harness.session.subscribe(
      { trackNamespace: ['live', 'stream1'], trackName: 'video' },
      {
        onOk,
        onObject: (object) => objects.push(object),
        onSubgroupEnd: (info) => subgroupEnds.push(info),
      }
    );

    const request = await harness.nextRequestStream();
    const message = await request.firstMessage;
    expect(message).toMatchObject({
      kind: 'subscribe',
      requestId: 0,
      trackNamespace: ['live', 'stream1'],
      trackName: 'video',
    });

    await request.send(encodeSubscribeOk(11));
    await vi.waitFor(() => expect(onOk).toHaveBeenCalled());
    expect(onOk).toHaveBeenCalledWith(expect.objectContaining({ trackAlias: 11 }));

    harness.openDataStream(encodeSubgroup(11, 41, utf8Encode('frame')));
    await vi.waitFor(() => expect(objects).toHaveLength(1));
    expect(objects[0]).toMatchObject({ groupId: 41, objectId: 0, subgroupId: 0, status: 'normal' });
    await vi.waitFor(() => expect(subgroupEnds).toHaveLength(1));
    expect(subgroupEnds[0]).toEqual({ groupId: 41, subgroupId: 0, endOfGroup: true });

    harness.session.destroy();
  });

  it('buffers a data stream that arrives before SUBSCRIBE_OK registers the alias', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const objects: MoqtObject[] = [];
    harness.session.subscribe(
      { trackNamespace: ['live'], trackName: 'audio' },
      { onObject: (object) => objects.push(object) }
    );
    const request = await harness.nextRequestStream();
    await request.firstMessage;

    // Objects outrace the SUBSCRIBE_OK.
    harness.openDataStream(encodeSubgroup(5, 100, utf8Encode('early')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(objects).toHaveLength(0);

    await request.send(encodeSubscribeOk(5));
    await vi.waitFor(() => expect(objects).toHaveLength(1));
    expect(objects[0]).toMatchObject({ groupId: 100 });

    harness.session.destroy();
  });

  it('drops a data stream whose alias never registers (timeout)', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();
    // No subscription at all — stream must be cancelled after the timeout,
    // and the session must survive.
    harness.openDataStream(encodeSubgroup(99, 1, utf8Encode('orphan')));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.getCloseInfo()).toBeUndefined();
    harness.session.destroy();
  });

  it('surfaces REQUEST_ERROR to the subscription handlers', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const onError = vi.fn();
    harness.session.subscribe({ trackNamespace: ['live'], trackName: 'nope' }, { onError });
    const request = await harness.nextRequestStream();
    await request.firstMessage;
    await request.send(encodeRequestError(REQUEST_ERROR_CODE.DOES_NOT_EXIST, 'no such track'));

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST, reason: 'no such track' })
    );
    harness.session.destroy();
  });

  it('surfaces PUBLISH_DONE and keeps late subgroups flowing until cancel', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const onDone = vi.fn();
    const objects: MoqtObject[] = [];
    const subscription = harness.session.subscribe(
      { trackNamespace: ['live'], trackName: 'video' },
      { onDone, onObject: (object) => objects.push(object) }
    );
    const request = await harness.nextRequestStream();
    await request.firstMessage;
    await request.send(encodeSubscribeOk(7));
    await request.send(encodePublishDone(PUBLISH_DONE_STATUS.TRACK_ENDED, 1, 'ended'));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED }));

    // A late-opening stream still routes (PUBLISH_DONE often beats data).
    harness.openDataStream(encodeSubgroup(7, 1, utf8Encode('late')));
    await vi.waitFor(() => expect(objects).toHaveLength(1));

    subscription.cancel();
    harness.session.destroy();
  });

  it('allocates even request IDs starting at 0', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();
    const first = harness.session.subscribe({ trackNamespace: ['a'], trackName: 'x' });
    const second = harness.session.subscribe({ trackNamespace: ['a'], trackName: 'y' });
    expect(first.requestId).toBe(0);
    expect(second.requestId).toBe(2);
    harness.session.destroy();
  });

  it('routes fetch streams by request id (catalog joining-fetch shape)', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const subscription = harness.session.subscribe({ trackNamespace: ['live'], trackName: 'catalog' });
    const subscribeStream = await harness.nextRequestStream();
    await subscribeStream.firstMessage;

    const entries: unknown[] = [];
    const onEnd = vi.fn();
    harness.session.fetch(
      { type: 'relative-joining', joiningRequestId: subscription.requestId, joiningStart: 0 },
      { onEntry: (entry) => entries.push(entry), onEnd }
    );
    const fetchStream = await harness.nextRequestStream();
    const fetchMessage = await fetchStream.firstMessage;
    expect(fetchMessage).toMatchObject({
      kind: 'fetch',
      request: { type: 'relative-joining', requestId: 2, joiningRequestId: 0, joiningStart: 0 },
    });

    // Fetch data stream: FETCH_HEADER + one object.
    const writer = new ByteWriter();
    writer.writeVarint(0x05);
    writer.writeVarint(2); // fetch request id
    writer.writeVarint(0x1c); // group delta + object delta + priority present
    writer.writeVarint(41); // group (absolute)
    writer.writeVarint(0); // object (absolute)
    writer.writeUint8(128);
    const payload = utf8Encode('{"version":"1"}');
    writer.writeVarint(payload.length);
    writer.writeBytes(payload);
    harness.openDataStream(writer.toBytes());

    await vi.waitFor(() => expect(entries).toHaveLength(1));
    expect(entries[0]).toMatchObject({ kind: 'object', groupId: 41, objectId: 0 });
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

    harness.session.destroy();
  });

  it('tolerates REQUEST_OK in place of FETCH_OK on a fetch stream (relay deviation)', async () => {
    const onClosed = vi.fn();
    const harness = createSessionHarness({ onClosed });
    harness.sendServerSetup();

    const subscription = harness.session.subscribe({ trackNamespace: ['live'], trackName: 'catalog' });
    await harness.nextRequestStream();

    const entries: unknown[] = [];
    const onEnd = vi.fn();
    harness.session.fetch(
      { type: 'relative-joining', joiningRequestId: subscription.requestId, joiningStart: 0 },
      { onEntry: (entry) => entries.push(entry), onEnd }
    );
    const fetchStream = await harness.nextRequestStream();
    await fetchStream.firstMessage;
    await fetchStream.send(encodeRequestOk());

    // The data stream still delivers normally — REQUEST_OK on the bidi
    // stream has no bearing on the separate unidirectional data stream.
    const writer = new ByteWriter();
    writer.writeVarint(0x05);
    writer.writeVarint(2); // fetch request id
    writer.writeVarint(0x1c); // group delta + object delta + priority present
    writer.writeVarint(41); // group (absolute)
    writer.writeVarint(0); // object (absolute)
    writer.writeUint8(128);
    const payload = utf8Encode('{"version":"1"}');
    writer.writeVarint(payload.length);
    writer.writeBytes(payload);
    harness.openDataStream(writer.toBytes());

    await vi.waitFor(() => expect(entries).toHaveLength(1));
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());
    expect(onClosed).not.toHaveBeenCalled();

    harness.session.destroy();
  });

  it('rejects ready when the session closes before the server SETUP', async () => {
    const harness = createSessionHarness();
    harness.session.close();
    await expect(harness.session.ready).rejects.toThrow('session closed before server SETUP');
  });

  it('reports a transport drop before the server SETUP as an error close', async () => {
    const onClosed = vi.fn();
    const harness = createSessionHarness({ onClosed });
    harness.dropTransport();

    // Callback-only consumers must observe the failure too — a clean
    // `onClosed({})` would read as a normal session close.
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(onClosed).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: 'session closed before server SETUP' }),
    });
    await expect(harness.session.ready).rejects.toThrow('session closed before server SETUP');
  });

  it('reports a local close() before the server SETUP as a clean close', async () => {
    const onClosed = vi.fn();
    const harness = createSessionHarness({ onClosed });
    harness.session.close();

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(onClosed).toHaveBeenCalledWith({});
  });

  it('reports a reset fetch stream as onReset, not a clean onEnd', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    const subscription = harness.session.subscribe({ trackNamespace: ['live'], trackName: 'catalog' });
    const subscribeStream = await harness.nextRequestStream();
    await subscribeStream.firstMessage;

    const entries: unknown[] = [];
    const onEnd = vi.fn();
    const onReset = vi.fn();
    harness.session.fetch(
      { type: 'relative-joining', joiningRequestId: subscription.requestId, joiningStart: 0 },
      { onEntry: (entry) => entries.push(entry), onEnd, onReset }
    );
    const fetchStream = await harness.nextRequestStream();
    await fetchStream.firstMessage;

    // Fetch data stream: header + one full entry, then a reset mid-replay.
    const writer = new ByteWriter();
    writer.writeVarint(0x05);
    writer.writeVarint(2); // fetch request id
    writer.writeVarint(0x1c); // group delta + object delta + priority present
    writer.writeVarint(41);
    writer.writeVarint(0);
    writer.writeUint8(128);
    const payload = utf8Encode('{"version":"1"}');
    writer.writeVarint(payload.length);
    writer.writeBytes(payload);
    const dataStream = harness.openControlledDataStream();
    await dataStream.write(writer.toBytes());
    await vi.waitFor(() => expect(entries).toHaveLength(1));
    dataStream.reset(new Error('reset mid-replay'));

    await vi.waitFor(() => expect(onReset).toHaveBeenCalled());
    expect(onEnd).not.toHaveBeenCalled();

    harness.session.destroy();
  });

  it('treats a truncated response frame on a request stream as a protocol error', async () => {
    const onClosed = vi.fn();
    const harness = createSessionHarness({ onClosed });
    harness.sendServerSetup();
    await harness.session.ready;

    harness.session.subscribe({ trackNamespace: ['live'], trackName: 'video' });
    const request = await harness.nextRequestStream();
    await request.firstMessage;

    // A frame header promising a 100-byte body, then FIN with none of it.
    const partial = new ByteWriter();
    partial.writeVarint(0x04);
    partial.writeUint16(100);
    await request.send(partial.toBytes());
    await request.fin();

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(harness.getCloseInfo()).toMatchObject({ closeCode: 0x3 });
  });

  it('reports GOAWAY from the control stream', async () => {
    const onGoaway = vi.fn();
    const harness = createSessionHarness({ onGoaway });
    // Server control stream with SETUP then GOAWAY.
    const writer = new ByteWriter();
    const setup = encodeSetup([]);
    writer.writeBytes(setup);
    // GOAWAY with a migration URI.
    const goawayBody = new ByteWriter();
    const uri = utf8Encode('https://relay2.example.com/moq');
    goawayBody.writeVarint(uri.length);
    goawayBody.writeBytes(uri);
    goawayBody.writeVarint(1000);
    const goawayFrame = new ByteWriter();
    goawayFrame.writeVarint(0x10);
    goawayFrame.writeUint16(goawayBody.length);
    goawayFrame.writeBytes(goawayBody.toBytes());
    writer.writeBytes(goawayFrame.toBytes());
    harness.openDataStream(writer.toBytes());

    await vi.waitFor(() => expect(onGoaway).toHaveBeenCalled());
    expect(onGoaway).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionUri: 'https://relay2.example.com/moq', timeout: 1000 })
    );
    harness.session.destroy();
  });

  it('rejects incoming PUBLISH with UNINTERESTED by default', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    // Server-initiated PUBLISH request stream.
    const publishBody = new ByteWriter();
    publishBody.writeVarint(1); // server request id (odd)
    publishBody.writeVarint(1); // namespace field count
    const field = utf8Encode('live');
    publishBody.writeVarint(field.length);
    publishBody.writeBytes(field);
    const name = utf8Encode('unwanted');
    publishBody.writeVarint(name.length);
    publishBody.writeBytes(name);
    publishBody.writeVarint(9); // track alias
    publishBody.writeVarint(0); // parameter count
    const publishFrame = new ByteWriter();
    publishFrame.writeVarint(0x1d);
    publishFrame.writeUint16(publishBody.length);
    publishFrame.writeBytes(publishBody.toBytes());

    const { responses } = harness.openIncomingBidi(publishFrame.toBytes());
    const chunks = await responses;
    const deframer = new ControlMessageDeframer();
    const messages = chunks.flatMap((chunk) => deframer.push(chunk)).map(decodeControlMessage);
    expect(messages[0]).toMatchObject({ kind: 'request-error', errorCode: REQUEST_ERROR_CODE.UNINTERESTED });

    harness.session.destroy();
  });

  it('rejects incoming PUBLISH_NAMESPACE with NOT_SUPPORTED by default', async () => {
    const harness = createSessionHarness();
    harness.sendServerSetup();

    // Server-initiated PUBLISH_NAMESPACE request stream — relays commonly
    // announce active namespaces unsolicited to newly connected clients.
    const { responses } = harness.openIncomingBidi(encodePublishNamespace({ requestId: 1, trackNamespace: ['anon'] }));
    const chunks = await responses;
    const deframer = new ControlMessageDeframer();
    const messages = chunks.flatMap((chunk) => deframer.push(chunk)).map(decodeControlMessage);
    expect(messages[0]).toMatchObject({ kind: 'request-error', errorCode: REQUEST_ERROR_CODE.NOT_SUPPORTED });

    harness.session.destroy();
  });

  it('closes the session with PROTOCOL_VIOLATION on an unknown data stream type', async () => {
    const onClosed = vi.fn();
    const harness = createSessionHarness({ onClosed });
    harness.sendServerSetup();

    const writer = new ByteWriter();
    writer.writeVarint(0x0f); // not a valid unidirectional stream type
    harness.openDataStream(writer.toBytes());

    await vi.waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(harness.getCloseInfo()).toMatchObject({ closeCode: 0x3 });
  });
});
