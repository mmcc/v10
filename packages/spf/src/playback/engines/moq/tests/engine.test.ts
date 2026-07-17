import { describe, expect, it, vi } from 'vitest';
import { isResolvedPresentation } from '../../../../media/types';
import { ByteWriter, StreamReader, utf8Encode } from '../../../../network/moqt/bytes';
import {
  type ControlMessage,
  ControlMessageDeframer,
  decodeControlMessage,
  encodeRequestError,
  encodeSetup,
  encodeSubscribeOk,
  REQUEST_ERROR_CODE,
} from '../../../../network/moqt/control-messages';
import type { BidirectionalStreamLike } from '../../../../network/moqt/request-stream';
import type { MoqtTransport } from '../../../../network/moqt/session';
import type { CreateMoqTransport } from '../../../actors/moq-session';
import { createMoqEngine, type MoqEngineSignals } from '../engine';

// ============================================================================
// In-memory relay: speaks real draft-19 bytes over a fake WebTransport.
// ============================================================================

const CATALOG = JSON.stringify({
  version: '1',
  tracks: [
    {
      name: 'video',
      packaging: 'loc',
      isLive: true,
      role: 'video',
      codec: 'vp8',
      width: 64,
      height: 64,
      bitrate: 200_000,
    },
  ],
});

/** One LOC object on its own subgroup stream (MSF: one object per stream). */
function encodeLocObjectStream(
  trackAlias: number,
  groupId: number,
  objectId: number,
  timestampUs: number,
  payload: Uint8Array
): Uint8Array {
  const writer = new ByteWriter();
  writer.writeVarint(0x39); // subgroup header: id 0, default priority, PROPERTIES
  writer.writeVarint(trackAlias);
  writer.writeVarint(groupId);
  writer.writeVarint(objectId); // first object on the stream: absolute id
  const properties = new ByteWriter();
  properties.writeVarint(0x06); // LOC Timestamp
  properties.writeVarint(timestampUs);
  const propertyBytes = properties.toBytes();
  writer.writeVarint(propertyBytes.length);
  writer.writeBytes(propertyBytes);
  writer.writeVarint(payload.length);
  writer.writeBytes(payload);
  return writer.toBytes();
}

interface RelaySubscription {
  message: Extract<ControlMessage, { kind: 'subscribe' }>;
  trackAlias: number;
}

function createFakeRelay() {
  let uniController!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const subscriptions: RelaySubscription[] = [];
  let nextAlias = 1;

  const openUni = (bytes: Uint8Array) => {
    const pipe = new TransformStream<Uint8Array, Uint8Array>();
    const writer = pipe.writable.getWriter();
    void writer.write(bytes).then(() => writer.close());
    uniController.enqueue(pipe.readable);
  };

  const handleRequestStream = async (stream: BidirectionalStreamLike) => {
    const reader = new StreamReader(stream.readable);
    const deframer = new ControlMessageDeframer();
    const writer = stream.writable.getWriter();
    const type = await reader.readVarint();
    const high = await reader.readUint8();
    const low = await reader.readUint8();
    const body = await reader.readBytes(high * 256 + low);
    const message = decodeControlMessage({ type, body });
    void deframer;

    if (message.kind === 'subscribe') {
      const trackAlias = nextAlias++;
      subscriptions.push({ message, trackAlias });
      await writer.write(encodeSubscribeOk(trackAlias));
      if (message.trackName === 'catalog') {
        // Serve the current catalog as a live independent object.
        openUni(encodeLocObjectStream(trackAlias, 0, 0, 0, utf8Encode(CATALOG)));
      }
      return;
    }
    if (message.kind === 'fetch') {
      // No history — the engine falls back to live catalog objects.
      await writer.write(encodeRequestError(REQUEST_ERROR_CODE.INVALID_RANGE, 'nothing published'));
      await writer.close();
      return;
    }
  };

  const transport: MoqtTransport = {
    incomingUnidirectionalStreams: new ReadableStream({
      start(controller) {
        uniController = controller;
      },
    }),
    incomingBidirectionalStreams: new ReadableStream({ start() {} }),
    async createUnidirectionalStream() {
      // Client control stream: drain it (SETUP + GOAWAY on close).
      return new WritableStream<Uint8Array>();
    },
    async createBidirectionalStream() {
      const clientToServer = new TransformStream<Uint8Array, Uint8Array>();
      const serverToClient = new TransformStream<Uint8Array, Uint8Array>();
      void handleRequestStream({ readable: clientToServer.readable, writable: serverToClient.writable });
      return { readable: serverToClient.readable, writable: clientToServer.writable };
    },
    close: () => {},
    closed: new Promise(() => {}),
  };

  const createMoqTransport: CreateMoqTransport = () => {
    // Server SETUP arrives immediately after connect.
    queueMicrotask(() => {
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      void pipe.writable.getWriter().write(encodeSetup([]));
      uniController.enqueue(pipe.readable);
    });
    return { transport, ready: Promise.resolve() };
  };

  return { createMoqTransport, subscriptions, openUni };
}

/** Encode one VP8 keyframe so the renderer has something real to decode. */
async function encodeKeyframe(): Promise<Uint8Array> {
  let payload: Uint8Array | undefined;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
    },
    error: () => {},
  });
  encoder.configure({ codec: 'vp8', width: 64, height: 64, bitrate: 200_000 });
  const canvas = new OffscreenCanvas(64, 64);
  canvas.getContext('2d')!.fillRect(0, 0, 64, 64);
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  encoder.encode(frame, { keyFrame: true });
  frame.close();
  await encoder.flush();
  encoder.close();
  return payload!;
}

// ============================================================================
// Tests
// ============================================================================

describe('createMoqEngine', () => {
  it('resolves the catalog, selects, subscribes, and renders end to end', async () => {
    const relay = createFakeRelay();
    let signals!: MoqEngineSignals;
    const engine = createMoqEngine({
      createMoqTransport: relay.createMoqTransport,
      onSignalsReady: (refs) => {
        signals = refs;
      },
    });

    const canvas = document.createElement('canvas');
    signals.context.renderSurface.set(canvas);
    signals.state.presentation.set({ url: 'moqt://relay.test/live#msf:live--catalog' });
    signals.state.loadActivated.set(true);

    // Catalog resolves off the live catalog object.
    await vi.waitFor(() => expect(isResolvedPresentation(signals.state.presentation.get())).toBe(true), {
      timeout: 5000,
    });

    // The reused selection machinery picks the only video track, and the
    // subscribe behavior turns it into a MoQ subscription.
    await vi.waitFor(() => expect(signals.state.selectedVideoTrackId.get()).toBe('live/video'));
    await vi.waitFor(() => {
      expect(relay.subscriptions.map((s) => s.message.trackName)).toContain('video');
    });
    expect(signals.context.videoSubscriberActor.get()).toBeDefined();

    // Serve a keyframe: it flows subgroup stream → jitter buffer →
    // VideoDecoder → canvas.
    const videoSubscription = relay.subscriptions.find((s) => s.message.trackName === 'video')!;
    relay.openUni(encodeLocObjectStream(videoSubscription.trackAlias, 1, 0, 1_000, await encodeKeyframe()));

    await vi.waitFor(
      () => expect(signals.context.videoRendererActor.get()?.snapshot.get().context.framesDecoded).toBeGreaterThan(0),
      { timeout: 5000 }
    );

    await engine.destroy();
  });

  it('subscribes to the catalog with the largest-object filter', async () => {
    const relay = createFakeRelay();
    let signals!: MoqEngineSignals;
    const engine = createMoqEngine({
      createMoqTransport: relay.createMoqTransport,
      onSignalsReady: (refs) => {
        signals = refs;
      },
    });

    signals.state.presentation.set({ url: 'moqt://relay.test/live#msf:live--catalog' });
    signals.state.loadActivated.set(true);

    // The catalog subscription comes first (the video-track subscription
    // may follow immediately once the catalog resolves).
    await vi.waitFor(() => expect(relay.subscriptions.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    expect(relay.subscriptions[0]!.message).toMatchObject({
      trackNamespace: ['live'],
      trackName: 'catalog',
      parameters: { locationFilter: { type: 'largest-object' } },
    });

    await engine.destroy();
  });
});
