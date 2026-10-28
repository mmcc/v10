/**
 * Symmetric in-memory `MoqtTransport` pair for loopback tests: two transports whose stream-creation methods surface on
 * the peer's incoming stream queues, so a publish session on one side can talk to a subscribe session on the other over
 * real (in-process) WHATWG streams — the same structural seam a `WebTransport` satisfies in production.
 */
import type { BidirectionalStreamLike, MoqtTransport } from '@caprid/moq-core';

import { decodeVarint, encodeVarint } from './moqt-wire';

interface PushChannel<T> {
  stream: ReadableStream<T>;
  push(value: T): void;
}

function pushChannel<T>(): PushChannel<T> {
  let controller!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(c) {
      controller = c;
    },
  });

  return { stream, push: (value) => controller.enqueue(value) };
}

export interface TransportPair {
  client: MoqtTransport;
  server: MoqtTransport;
}

/** Create two transports wired back-to-back. */
export function createTransportPair(): TransportPair {
  const makeSide = () => ({
    incomingUni: pushChannel<ReadableStream<Uint8Array>>(),
    incomingBidi: pushChannel<BidirectionalStreamLike>(),
    resolveClosed: undefined as ((info: unknown) => void) | undefined,
  });
  const a = makeSide();
  const b = makeSide();

  let closed = false;
  const closedPromises = [a, b].map(
    (side) =>
      new Promise<unknown>((resolve) => {
        side.resolveClosed = resolve;
      })
  );

  const closeBoth = (info?: { closeCode?: number; reason?: string }): void => {
    if (closed) return;

    closed = true;
    a.resolveClosed?.(info);
    b.resolveClosed?.(info);
  };

  const makeTransport = (local: typeof a, remote: typeof b, closedPromise: Promise<unknown>): MoqtTransport => ({
    incomingUnidirectionalStreams: local.incomingUni.stream,
    incomingBidirectionalStreams: local.incomingBidi.stream,
    async createUnidirectionalStream() {
      if (closed) throw new Error('transport closed');

      const pipe = new TransformStream<Uint8Array, Uint8Array>();

      remote.incomingUni.push(pipe.readable);
      return pipe.writable;
    },
    async createBidirectionalStream() {
      if (closed) throw new Error('transport closed');

      const localToRemote = new TransformStream<Uint8Array, Uint8Array>();
      const remoteToLocal = new TransformStream<Uint8Array, Uint8Array>();

      remote.incomingBidi.push({ readable: localToRemote.readable, writable: remoteToLocal.writable });
      return { readable: remoteToLocal.readable, writable: localToRemote.writable };
    },
    close(closeInfo) {
      closeBoth(closeInfo);
    },
    closed: closedPromise,
  });

  return {
    client: makeTransport(a, b, closedPromises[0]!),
    server: makeTransport(b, a, closedPromises[1]!),
  };
}

/**
 * Offset added to the Request IDs of a subscribe session standing in for the relay (see `withServerRequestIds`). Odd,
 * so the client's even IDs become server ones, and far above the small odd IDs tests hand `raw-peer` requests.
 */
export const SERVER_REQUEST_ID_OFFSET = 1_000_001;

/**
 * Give a subscribe session standing in for the relay the server's (odd) Request IDs: the publish session closes with
 * INVALID_REQUEST_ID on a peer request carrying the client's (even) parity (§6.4.2.1), and the subscribe driver only
 * allocates client IDs. Each request stream's first message — the request itself — has {@link SERVER_REQUEST_ID_OFFSET}
 * added to its Request ID. The publish session uses that Request ID as the Track Alias, so a binding reads
 * `subscription.requestId + SERVER_REQUEST_ID_OFFSET`.
 */
export function withServerRequestIds(transport: MoqtTransport): MoqtTransport {
  return {
    ...transport,
    async createBidirectionalStream() {
      const stream = await transport.createBidirectionalStream();

      return { readable: stream.readable, writable: offsetFirstRequestId(stream.writable) };
    },
  };
}

function offsetFirstRequestId(target: WritableStream<Uint8Array>): WritableStream<Uint8Array> {
  let pending: Uint8Array | undefined = new Uint8Array(0);
  const rewrite = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!pending) {
        controller.enqueue(chunk);
        return;
      }

      const bytes = new Uint8Array(pending.length + chunk.length);

      bytes.set(pending);
      bytes.set(chunk, pending.length);
      pending = bytes;

      // Message Type (varint), Message Length (16 bits), then the body, whose
      // first field is the Request ID.
      let type: ReturnType<typeof decodeVarint>;

      try {
        type = decodeVarint(bytes);
      } catch {
        return;
      }

      const bodyStart = type.byteLength + 2;
      if (bytes.length < bodyStart) return;

      const bodyLength = (bytes[type.byteLength]! << 8) | bytes[type.byteLength + 1]!;
      if (bytes.length < bodyStart + bodyLength) return;

      const requestId = decodeVarint(bytes, bodyStart);
      const rest = bytes.subarray(bodyStart + requestId.byteLength);
      const id = encodeVarint(requestId.value + SERVER_REQUEST_ID_OFFSET);
      const newBodyLength = bodyLength - requestId.byteLength + id.length;
      const out = new Uint8Array(bodyStart + id.length + rest.length);

      out.set(bytes.subarray(0, type.byteLength));
      out[type.byteLength] = newBodyLength >> 8;
      out[type.byteLength + 1] = newBodyLength & 0xff;
      out.set(id, bodyStart);
      out.set(rest, bodyStart + id.length);
      pending = undefined;
      controller.enqueue(out);
    },
  });

  void rewrite.readable.pipeTo(target).catch(() => {});
  return rewrite.writable;
}
