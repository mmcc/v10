import { describe, expect, it, vi } from 'vitest';
import { toLocFrame } from '../../../media/moq/loc';
import { packageLocFrame } from '../../../media/moq/loc-packaging';
import { StreamReader } from '../../../network/moqt/bytes';
import { type MoqtObject, readSubgroupHeader, readSubgroupObjects } from '../../../network/moqt/object-stream';
import { createTrackPublisherActor, type TrackPublisherActor } from '../track-publisher';

// =============================================================================
// In-memory uni-stream factory with switchable write backpressure
// =============================================================================

interface FakeUniStream {
  chunks: Uint8Array[];
  closed: boolean;
  aborted: boolean;
  abortReason?: unknown;
}

function makeStreamFactory() {
  const streams: FakeUniStream[] = [];
  const releases: (() => void)[] = [];
  const factory = {
    /** While true, writes stay pending until `releaseAll()`. */
    gate: false,
    streams,
    releaseAll() {
      for (const release of releases.splice(0)) release();
    },
    openUniStream: async (): Promise<WritableStream<Uint8Array>> => {
      const record: FakeUniStream = { chunks: [], closed: false, aborted: false };
      streams.push(record);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          record.chunks.push(chunk);
          if (!factory.gate) return undefined;
          return new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        },
        close() {
          record.closed = true;
        },
        abort(reason) {
          record.aborted = true;
          record.abortReason = reason;
        },
      });
    },
  };
  return factory;
}

function readableFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Parse one fully written subgroup stream with the network reader. */
async function parseSubgroup(stream: FakeUniStream) {
  const reader = new StreamReader(readableFrom(stream.chunks));
  const type = await reader.readVarint();
  const header = await readSubgroupHeader(reader, type);
  const objects: MoqtObject[] = [];
  for await (const object of readSubgroupObjects(reader, header)) objects.push(object);
  return { header, objects };
}

/** LOC-package a fake encoded chunk into a frame message payload. */
function locFrame(timestampUs: number, bytes: number[], config?: Uint8Array) {
  const data = new Uint8Array(bytes);
  return packageLocFrame(
    {
      type: config ? 'key' : 'delta',
      timestamp: timestampUs,
      byteLength: data.length,
      copyTo: (destination: Uint8Array) => destination.set(data),
    },
    config ? { videoConfig: config } : {}
  );
}

function counters(publisher: TrackPublisherActor) {
  return publisher.snapshot.get().context;
}

describe('createTrackPublisherActor', () => {
  it('maps keyframes to group boundaries and round-trips LOC frames through the reader', async () => {
    const factory = makeStreamFactory();
    const publisher = createTrackPublisherActor({ openUniStream: factory.openUniStream, trackAlias: 5 });

    const config = new Uint8Array([9, 9]);
    const key0 = locFrame(0, [1, 2, 3], config);
    publisher.send({
      type: 'frame',
      payload: key0.payload,
      properties: key0.properties,
      keyframe: true,
      timestampUs: 0,
    });
    const delta1 = locFrame(33_333, [4, 5]);
    publisher.send({
      type: 'frame',
      payload: delta1.payload,
      properties: delta1.properties,
      keyframe: false,
      timestampUs: 33_333,
    });
    const key1 = locFrame(66_666, [6], config);
    publisher.send({
      type: 'frame',
      payload: key1.payload,
      properties: key1.properties,
      keyframe: true,
      timestampUs: 66_666,
    });
    publisher.send({ type: 'end' });

    await vi.waitFor(() => {
      expect(factory.streams).toHaveLength(2);
      expect(factory.streams[0]!.closed).toBe(true);
      expect(factory.streams[1]!.closed).toBe(true);
    });

    const group0 = await parseSubgroup(factory.streams[0]!);
    expect(group0.header.trackAlias).toBe(5);
    expect(group0.header.groupId).toBe(0);
    expect(group0.header.endOfGroup).toBe(true);
    expect(group0.objects.map((o) => o.objectId)).toEqual([0, 1]);

    // The subscriber-side LOC extraction sees exactly what was packaged.
    const frame0 = toLocFrame(group0.objects[0]!)!;
    expect(frame0.isKey).toBe(true);
    expect(frame0.timestampUs).toBe(0);
    expect(frame0.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(frame0.videoConfig).toEqual(config);
    const frame1 = toLocFrame(group0.objects[1]!)!;
    expect(frame1.isKey).toBe(false);
    expect(frame1.timestampUs).toBe(33_333);

    const group1 = await parseSubgroup(factory.streams[1]!);
    expect(group1.header.groupId).toBe(1);
    expect(group1.objects.map((o) => o.objectId)).toEqual([0]);
    expect(toLocFrame(group1.objects[0]!)!.isKey).toBe(true);

    await vi.waitFor(() => {
      expect(counters(publisher)).toMatchObject({
        publishedGroups: 2,
        publishedObjects: 3,
        droppedGroups: 0,
        bytesSent: 6,
        queuedGroups: 0,
        lastTimestampUs: 66_666,
      });
    });
    expect(publisher.snapshot.get().value).toBe('ended');
    publisher.destroy();
  });

  it('publishes every frame as its own group in groupPerFrame mode', async () => {
    const factory = makeStreamFactory();
    const publisher = createTrackPublisherActor({
      openUniStream: factory.openUniStream,
      trackAlias: 3,
      groupPerFrame: true,
    });

    for (let i = 0; i < 3; i++) {
      const frame = locFrame(i * 20_000, [i]);
      // groupPerFrame ignores the keyframe flag — audio frames arrive unmarked.
      publisher.send({
        type: 'frame',
        payload: frame.payload,
        properties: frame.properties,
        keyframe: false,
        timestampUs: i * 20_000,
      });
    }

    await vi.waitFor(() => {
      expect(factory.streams).toHaveLength(3);
      expect(factory.streams.every((stream) => stream.closed)).toBe(true);
    });
    for (let i = 0; i < 3; i++) {
      const { header, objects } = await parseSubgroup(factory.streams[i]!);
      expect(header.groupId).toBe(i);
      expect(objects.map((o) => o.objectId)).toEqual([0]);
    }
    await vi.waitFor(() => {
      expect(counters(publisher)).toMatchObject({ publishedGroups: 3, publishedObjects: 3, queuedGroups: 0 });
    });
    publisher.destroy();
  });

  it('sustains group-per-frame publishing when stream close acks lag behind the frame cadence', async () => {
    // Models a real relay leg: writes are accepted immediately (send
    // buffer), but close() only settles ~10 frame intervals later (the
    // QUIC stream close acknowledgment round trip — measured ~54 ms
    // against relay.mux.dev, vs a 20 ms opus frame cadence). That
    // settlement is peer latency, not backpressure: it must neither
    // serialize the next group's stream work behind it nor count toward
    // `maxQueuedGroups`. Before the fix this decimated audio (~80% of
    // groups reset by the drop policy) while in-memory transports, whose
    // close() settles instantly, showed nothing.
    const streams: FakeUniStream[] = [];
    const openUniStream = async (): Promise<WritableStream<Uint8Array>> => {
      const record: FakeUniStream = { chunks: [], closed: false, aborted: false };
      streams.push(record);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          record.chunks.push(chunk);
        },
        close() {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              record.closed = true;
              resolve();
            }, 50);
          });
        },
        abort(reason) {
          record.aborted = true;
          record.abortReason = reason;
        },
      });
    };
    const publisher = createTrackPublisherActor({ openUniStream, trackAlias: 3, groupPerFrame: true });

    for (let i = 0; i < 10; i++) {
      const frame = locFrame(i * 20_000, [i]);
      publisher.send({
        type: 'frame',
        payload: frame.payload,
        properties: frame.properties,
        keyframe: false,
        timestampUs: i * 20_000,
      });
      // Frame pacing: several frames arrive while earlier closes are
      // still settling.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await vi.waitFor(() => {
      expect(counters(publisher)).toMatchObject({
        openedGroups: 10,
        publishedGroups: 10,
        publishedObjects: 10,
        droppedGroups: 0,
        queuedGroups: 0,
      });
    });
    expect(streams).toHaveLength(10);
    expect(streams.every((stream) => stream.closed && !stream.aborted)).toBe(true);
    publisher.destroy();
  });

  it('ignores delta frames before the first keyframe', async () => {
    const factory = makeStreamFactory();
    const publisher = createTrackPublisherActor({ openUniStream: factory.openUniStream, trackAlias: 1 });

    const delta = locFrame(0, [1]);
    publisher.send({
      type: 'frame',
      payload: delta.payload,
      properties: delta.properties,
      keyframe: false,
      timestampUs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factory.streams).toHaveLength(0);
    expect(counters(publisher).publishedObjects).toBe(0);
    publisher.destroy();
  });

  it('drops stale groups behind transport backpressure and resumes at the next keyframe', async () => {
    const factory = makeStreamFactory();
    factory.gate = true;
    const publisher = createTrackPublisherActor({
      openUniStream: factory.openUniStream,
      trackAlias: 2,
      maxQueuedGroups: 1,
    });

    const sendKey = (timestampUs: number) => {
      const frame = locFrame(timestampUs, [1, 2], new Uint8Array([7]));
      publisher.send({
        type: 'frame',
        payload: frame.payload,
        properties: frame.properties,
        keyframe: true,
        timestampUs,
      });
    };

    sendKey(0); // group 0 — its header write hangs on the gate
    await vi.waitFor(() => {
      expect(factory.streams).toHaveLength(1);
    });
    sendKey(2_000_000); // group 1 — queued behind group 0
    expect(counters(publisher).queuedGroups).toBe(2);

    // Group 2's boundary finds 2 unfinished groups > maxQueuedGroups(1):
    // both are dropped and the in-flight stream is reset.
    sendKey(4_000_000);
    expect(counters(publisher).droppedGroups).toBe(2);
    expect(counters(publisher).queuedGroups).toBe(1);

    factory.gate = false;
    // Settle the in-flight (gated) sink write so the stream can finish
    // erroring — WHATWG streams only run the sink's abort() after the
    // in-flight write completes.
    factory.releaseAll();
    await vi.waitFor(() => {
      expect(factory.streams[0]!.aborted).toBe(true);
      // Publishing resumed with a fresh stream for group 2.
      expect(factory.streams).toHaveLength(2);
    });

    publisher.send({ type: 'end' });
    await vi.waitFor(() => {
      expect(factory.streams[1]!.closed).toBe(true);
    });
    const { header, objects } = await parseSubgroup(factory.streams[1]!);
    expect(header.groupId).toBe(2);
    expect(objects.map((o) => o.objectId)).toEqual([0]);
    await vi.waitFor(() => {
      expect(counters(publisher)).toMatchObject({ publishedGroups: 1, droppedGroups: 2, queuedGroups: 0 });
    });
    // Streams actually opened: group 0 (later reset) and group 2. Group 1
    // was dropped while queued — it never opened a stream, and counting it
    // would inflate PUBLISH_DONE's Stream Count with a stream the peer can
    // never receive.
    expect(counters(publisher).openedGroups).toBe(2);
    publisher.destroy();
  });

  it('aborts a stream whose open was still in flight when destroy() ran', async () => {
    const streams: FakeUniStream[] = [];
    let resolveOpen: ((stream: WritableStream<Uint8Array>) => void) | undefined;
    const openUniStream = (): Promise<WritableStream<Uint8Array>> =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      });
    const publisher = createTrackPublisherActor({ openUniStream, trackAlias: 7 });

    const key = locFrame(0, [1, 2], new Uint8Array([7]));
    publisher.send({ type: 'frame', payload: key.payload, properties: key.properties, keyframe: true, timestampUs: 0 });
    await vi.waitFor(() => {
      expect(resolveOpen).toBeDefined();
    });

    // destroy() cannot FIN this group — its writer does not exist yet. When
    // the transport finally hands the stream over, it must be aborted, not
    // written to: a write here would publish after teardown and leak the
    // stream (never FINned, never reset).
    publisher.destroy();
    const record: FakeUniStream = { chunks: [], closed: false, aborted: false };
    streams.push(record);
    resolveOpen!(
      new WritableStream<Uint8Array>({
        write(chunk) {
          record.chunks.push(chunk);
        },
        close() {
          record.closed = true;
        },
        abort(reason) {
          record.aborted = true;
          record.abortReason = reason;
        },
      })
    );

    await vi.waitFor(() => {
      expect(streams[0]!.aborted).toBe(true);
    });
    expect(streams[0]!.chunks).toHaveLength(0);
    expect(streams[0]!.closed).toBe(false);
  });

  it('reports stream failures through onError and counts the group as dropped', async () => {
    const onError = vi.fn();
    const publisher = createTrackPublisherActor({
      openUniStream: async () => {
        throw new Error('no more streams');
      },
      trackAlias: 1,
      onError,
    });

    const frame = locFrame(0, [1]);
    publisher.send({
      type: 'frame',
      payload: frame.payload,
      properties: frame.properties,
      keyframe: true,
      timestampUs: 0,
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no more streams' }));
      expect(counters(publisher).droppedGroups).toBe(1);
    });
    publisher.destroy();
  });

  it('counts opened groups (streams) on the snapshot, including unfinished ones', async () => {
    const factory = makeStreamFactory();
    const publisher = createTrackPublisherActor({ openUniStream: factory.openUniStream, trackAlias: 6 });

    const sendKey = (timestampUs: number) => {
      const frame = locFrame(timestampUs, [1], new Uint8Array([7]));
      publisher.send({
        type: 'frame',
        payload: frame.payload,
        properties: frame.properties,
        keyframe: true,
        timestampUs,
      });
    };
    sendKey(0);
    sendKey(1_000_000);
    // Group 1 is still open (no boundary/FIN yet): the opened count —
    // which lands as each group's wire stream actually opens — leads the
    // published (FINed) count; draft-19's PUBLISH_DONE Stream Count wants
    // streams opened, not streams completed.
    await vi.waitFor(() => {
      expect(counters(publisher).openedGroups).toBe(2);
    });
    await vi.waitFor(() => {
      expect(counters(publisher).publishedGroups).toBe(1);
    });
    expect(counters(publisher).openedGroups).toBe(2);
    publisher.destroy();
  });

  it('destroy() under backpressure resets abandoned groups and unblocks their writes', async () => {
    const factory = makeStreamFactory();
    factory.gate = true;
    const publisher = createTrackPublisherActor({ openUniStream: factory.openUniStream, trackAlias: 4 });

    const sendKey = (timestampUs: number) => {
      const frame = locFrame(timestampUs, [1, 2], new Uint8Array([7]));
      publisher.send({
        type: 'frame',
        payload: frame.payload,
        properties: frame.properties,
        keyframe: true,
        timestampUs,
      });
    };

    sendKey(0); // group 0 — its header write hangs on the gate
    await vi.waitFor(() => {
      expect(factory.streams).toHaveLength(1);
    });
    sendKey(1_000_000); // group 1 — open task queued behind group 0
    sendKey(2_000_000); // group 2 — the current cell, stream not yet opened
    expect(counters(publisher).queuedGroups).toBe(3);
    // Only group 0 ever opened a wire stream — groups 1 and 2 are queued
    // behind its gated write, and the opened count must not lead reality.
    await vi.waitFor(() => {
      expect(counters(publisher).openedGroups).toBe(1);
    });

    publisher.destroy();
    // Settle the in-flight (gated) sink write so the stream can finish
    // erroring — WHATWG streams only run the sink's abort() after the
    // in-flight write completes.
    factory.releaseAll();

    // Group 0 was abandoned mid-backpressure: destroy must reset its
    // stream (rejecting the hung write) rather than leave it dangling.
    await vi.waitFor(() => {
      expect(factory.streams[0]!.aborted).toBe(true);
    });
    // Groups 1 and 2 never opened wire streams (their open tasks died
    // with the runner) — nothing is left pending.
    expect(factory.streams).toHaveLength(1);
    expect(publisher.snapshot.get().value).toBe('destroyed');
  });

  it('destroy() finishes the open stream best-effort', async () => {
    const factory = makeStreamFactory();
    const publisher = createTrackPublisherActor({ openUniStream: factory.openUniStream, trackAlias: 1 });
    const frame = locFrame(0, [1], new Uint8Array([7]));
    publisher.send({
      type: 'frame',
      payload: frame.payload,
      properties: frame.properties,
      keyframe: true,
      timestampUs: 0,
    });
    await vi.waitFor(() => {
      expect(factory.streams).toHaveLength(1);
      expect(counters(publisher).publishedObjects).toBe(1);
    });

    publisher.destroy();
    await vi.waitFor(() => {
      expect(factory.streams[0]!.closed).toBe(true);
    });
    expect(publisher.snapshot.get().value).toBe('destroyed');
  });
});
