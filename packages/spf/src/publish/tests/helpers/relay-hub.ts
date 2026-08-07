/**
 * In-memory MoQ relay hub for cross-engine tests: real publish engine on
 * one side, real playback engine(s) on the other, draft-19 bytes in the
 * middle over `createTransportPair` transports.
 *
 * Publisher side (`connectPublisher`): answers the SETUP exchange, accepts
 * PUBLISH_NAMESPACE and per-track PUBLISH with REQUEST_OK, parses subgroup
 * data streams into per-track group buffers, and records every
 * PUBLISH_DONE it observes — the churn signal the source-switch
 * regression tests assert on.
 *
 * Subscriber side (`connectSubscriber`): answers SUBSCRIBE with
 * SUBSCRIBE_OK and forwards objects one-per-subgroup-stream, honoring the
 * request's location filter the way a spec-following relay does —
 * `largest-object` replays the newest buffered group then follows live
 * (catalog/audio joins), `next-group-start` forwards only groups that
 * start after the subscribe (video joins). FETCH is answered with
 * REQUEST_ERROR so the catalog resolution falls back to its live
 * subscription. A publisher PUBLISH_DONE is forwarded to the track's
 * subscribers, ending their subscriptions like a real relay would.
 *
 * Tracks persist across publisher sessions (a reconnecting publisher may
 * re-PUBLISH the same names), so the hub can also observe the pre-fix
 * teardown/reconnect churn instead of crashing on it.
 */
import { StreamReader } from '../../../network/moqt/bytes';
import {
  type ControlMessage,
  decodeControlMessage,
  encodePublishDone,
  encodeRequestError,
  encodeRequestOk,
  encodeSetup,
  encodeSubscribeOk,
  type KeyValuePair,
  REQUEST_ERROR_CODE,
} from '../../../network/moqt/control-messages';
import {
  isSubgroupHeaderType,
  readSubgroupHeader,
  readSubgroupObjects,
  STREAM_TYPE,
} from '../../../network/moqt/object-stream';
import type { BidirectionalStreamLike } from '../../../network/moqt/request-stream';
import type { MoqtTransport } from '../../../network/moqt/session';
import { createSubgroupWriter } from '../../../network/moqt/subgroup-writer';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import type { ConnectPublishTransport } from '../../session/publish-session';

// =============================================================================
// Types
// =============================================================================

interface BufferedObject {
  groupId: number;
  objectId: number;
  properties: KeyValuePair[];
  payload: Uint8Array;
}

interface Subscription {
  trackAlias: number;
  /** Only forward groups at/after this id (`next-group-start` joins). */
  minGroupId: number;
  deliver(object: BufferedObject): void;
  end(statusCode: number): void;
}

interface TrackRecord {
  name: string;
  /** Insertion-ordered groupId → objects, pruned to the newest few groups. */
  groups: Map<number, BufferedObject[]>;
  largestGroupId: number;
  objectsReceived: number;
  subscribers: Set<Subscription>;
}

export interface ObservedPublishDone {
  trackName: string;
  statusCode: number;
  streamCount: number;
}

export interface RelayHub {
  /** Transport seam for the publish engine's `connectTransport`. */
  connectPublisher: ConnectPublishTransport;
  /** Transport seam for the playback engine's `createMoqTransport`. */
  connectSubscriber: () => { transport: MoqtTransport; ready: Promise<void> };
  /** Track names PUBLISHed, in arrival order (re-publishes append again). */
  readonly publishes: string[];
  /** Every PUBLISH_DONE observed from the publisher, in arrival order. */
  readonly publishDones: ObservedPublishDone[];
  /** Publisher transports accepted so far (a reconnect increments this). */
  publisherConnections(): number;
  /** Total objects received from the publisher for one track. */
  objectCount(trackName: string): number;
  destroy(): void;
}

const MAX_BUFFERED_GROUPS = 3;

// =============================================================================
// Implementation
// =============================================================================

/** Read one length-framed control message (type varint already consumed). */
async function readControlFrame(reader: StreamReader, type: number): Promise<ControlMessage> {
  const high = await reader.readUint8();
  const low = await reader.readUint8();
  const body = await reader.readBytes(high * 256 + low);
  return decodeControlMessage({ type, body });
}

export function createRelayHub(): RelayHub {
  let destroyed = false;
  let nextSubscriberAlias = 1;
  let publisherConnections = 0;

  const publishes: string[] = [];
  const publishDones: ObservedPublishDone[] = [];
  const tracks = new Map<string, TrackRecord>();
  const closers = new Set<() => void>();

  const trackFor = (name: string): TrackRecord => {
    let track = tracks.get(name);
    if (!track) {
      track = { name, groups: new Map(), largestGroupId: -1, objectsReceived: 0, subscribers: new Set() };
      tracks.set(name, track);
    }
    return track;
  };

  const bufferAndForward = (track: TrackRecord, object: BufferedObject): void => {
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
    track.largestGroupId = Math.max(track.largestGroupId, object.groupId);
    track.objectsReceived++;
    for (const subscriber of track.subscribers) {
      if (object.groupId >= subscriber.minGroupId) subscriber.deliver(object);
    }
  };

  // ---------------------------------------------------------------------------
  // Publisher side
  // ---------------------------------------------------------------------------

  const connectPublisher: ConnectPublishTransport = () => {
    publisherConnections++;
    const pair = createTransportPair();
    const server = pair.server;
    // Track aliases are scoped to one publisher session.
    const aliasToTrack = new Map<number, TrackRecord>();
    /** Data streams can race their PUBLISH; wait briefly for the alias. */
    const resolveTrack = async (alias: number): Promise<TrackRecord | undefined> => {
      for (let i = 0; i < 200; i++) {
        const track = aliasToTrack.get(alias);
        if (track) return track;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return undefined;
    };

    const acceptUniStreams = async (): Promise<void> => {
      const streams = server.incomingUnidirectionalStreams.getReader();
      try {
        while (true) {
          const { done, value } = await streams.read();
          if (done) break;
          void (async () => {
            const reader = new StreamReader(value);
            try {
              const streamType = await reader.readVarint();
              if (streamType === STREAM_TYPE.SETUP) {
                // The publisher's control stream: SETUP now, GOAWAY at close.
                while (!(await reader.atEnd())) await reader.readUint8();
                return;
              }
              if (!isSubgroupHeaderType(streamType)) {
                await reader.cancel();
                return;
              }
              const header = await readSubgroupHeader(reader, streamType);
              const track = await resolveTrack(header.trackAlias);
              if (!track) {
                await reader.cancel();
                return;
              }
              for await (const object of readSubgroupObjects(reader, header)) {
                if (object.status !== 'normal') continue;
                bufferAndForward(track, {
                  groupId: object.groupId,
                  objectId: object.objectId,
                  properties: object.properties,
                  payload: object.payload,
                });
              }
            } catch {
              // Stream reset (drop path or teardown) — buffered objects stay.
            }
          })();
        }
      } catch {
        // Transport went away.
      }
    };

    const serveRequestStream = async (stream: BidirectionalStreamLike): Promise<void> => {
      const writer = stream.writable.getWriter();
      const reader = new StreamReader(stream.readable);
      let streamTrack: TrackRecord | undefined;
      try {
        while (!(await reader.atEnd())) {
          const type = await reader.readVarint();
          const message = await readControlFrame(reader, type);
          if (message.kind === 'publish') {
            streamTrack = trackFor(message.trackName);
            aliasToTrack.set(message.trackAlias, streamTrack);
            publishes.push(message.trackName);
            await writer.write(encodeRequestOk());
          } else if (message.kind === 'publish-namespace') {
            await writer.write(encodeRequestOk());
          } else if (message.kind === 'publish-done') {
            publishDones.push({
              trackName: streamTrack?.name ?? '(unknown)',
              statusCode: message.statusCode,
              streamCount: message.streamCount,
            });
            if (streamTrack) {
              // A real relay ends downstream subscriptions with the track.
              for (const subscriber of [...streamTrack.subscribers]) subscriber.end(message.statusCode);
              streamTrack.subscribers.clear();
            }
          }
          // REQUEST_UPDATE / GOAWAY: nothing to do for the hub.
        }
      } catch {
        // Reset or teardown.
      } finally {
        writer.close().catch(() => {});
      }
    };

    const acceptBidiStreams = async (): Promise<void> => {
      const streams = server.incomingBidirectionalStreams.getReader();
      try {
        while (true) {
          const { done, value } = await streams.read();
          if (done) break;
          void serveRequestStream(value);
        }
      } catch {
        // Transport went away.
      }
    };

    void acceptUniStreams();
    void acceptBidiStreams();
    // Server SETUP arrives on its own control stream right after connect.
    void (async () => {
      try {
        const control = await server.createUnidirectionalStream();
        await control.getWriter().write(encodeSetup());
      } catch {
        // Closed before SETUP could land.
      }
    })();

    closers.add(() => pair.client.close());
    return { transport: pair.client, ready: Promise.resolve() };
  };

  // ---------------------------------------------------------------------------
  // Subscriber side
  // ---------------------------------------------------------------------------

  const connectSubscriber = (): { transport: MoqtTransport; ready: Promise<void> } => {
    const pair = createTransportPair();
    const server = pair.server;
    let open = true;

    /** Forward one object on its own subgroup stream toward the player. */
    const forwardObject = (trackAlias: number, object: BufferedObject): void => {
      if (!open || destroyed) return;
      void (async () => {
        try {
          const stream = await server.createUnidirectionalStream();
          const writer = createSubgroupWriter(stream, {
            trackAlias,
            groupId: object.groupId,
            hasProperties: true,
            endOfGroup: false,
          });
          await writer.writeObject({
            objectId: object.objectId,
            properties: object.properties,
            payload: object.payload,
          });
          await writer.fin();
        } catch {
          // Subscriber went away.
        }
      })();
    };

    const serveRequestStream = async (stream: BidirectionalStreamLike): Promise<void> => {
      const writer = stream.writable.getWriter();
      const reader = new StreamReader(stream.readable);
      let subscription: Subscription | undefined;
      let subscribedTrack: TrackRecord | undefined;
      try {
        while (!(await reader.atEnd())) {
          const type = await reader.readVarint();
          const message = await readControlFrame(reader, type);
          if (message.kind === 'subscribe') {
            const track = trackFor(message.trackName);
            const trackAlias = nextSubscriberAlias++;
            await writer.write(encodeSubscribeOk(trackAlias));
            const filter = message.parameters.locationFilter ?? { type: 'largest-object' };
            const joinAtNextGroup = filter.type === 'next-group-start';
            subscription = {
              trackAlias,
              minGroupId: joinAtNextGroup ? track.largestGroupId + 1 : 0,
              deliver: (object) => forwardObject(trackAlias, object),
              end: (statusCode) => {
                void writer
                  .write(encodePublishDone(statusCode, 0, ''))
                  .then(() => writer.close())
                  .catch(() => {});
              },
            };
            if (!joinAtNextGroup && track.largestGroupId >= 0) {
              // Replay the newest buffered group, then follow live.
              for (const object of track.groups.get(track.largestGroupId) ?? []) subscription.deliver(object);
            }
            track.subscribers.add(subscription);
            subscribedTrack = track;
          } else if (message.kind === 'fetch') {
            await writer.write(encodeRequestError(REQUEST_ERROR_CODE.INVALID_RANGE, 'no history'));
            await writer.close();
            return;
          }
          // REQUEST_UPDATE / GOAWAY: ignored by the hub.
        }
      } catch {
        // Reset — the subscriber cancelled; ordinary end-of-request.
      } finally {
        if (subscribedTrack && subscription) subscribedTrack.subscribers.delete(subscription);
        writer.close().catch(() => {});
      }
    };

    const acceptBidiStreams = async (): Promise<void> => {
      const streams = server.incomingBidirectionalStreams.getReader();
      try {
        while (true) {
          const { done, value } = await streams.read();
          if (done) break;
          void serveRequestStream(value);
        }
      } catch {
        // Transport went away.
      }
    };

    const drainUniStreams = async (): Promise<void> => {
      // The player's control stream (SETUP + GOAWAY) lands here; drain it.
      const streams = server.incomingUnidirectionalStreams.getReader();
      try {
        while (true) {
          const { done, value } = await streams.read();
          if (done) break;
          void value.getReader().read();
        }
      } catch {
        // Transport went away.
      }
    };

    void acceptBidiStreams();
    void drainUniStreams();
    void (async () => {
      try {
        const control = await server.createUnidirectionalStream();
        await control.getWriter().write(encodeSetup());
      } catch {
        // Closed before SETUP could land.
      }
    })();

    closers.add(() => {
      open = false;
      pair.client.close();
    });
    return { transport: pair.client, ready: Promise.resolve() };
  };

  return {
    connectPublisher,
    connectSubscriber,
    publishes,
    publishDones,
    publisherConnections: () => publisherConnections,
    objectCount: (trackName) => tracks.get(trackName)?.objectsReceived ?? 0,
    destroy() {
      destroyed = true;
      for (const close of [...closers]) close();
      closers.clear();
    },
  };
}
