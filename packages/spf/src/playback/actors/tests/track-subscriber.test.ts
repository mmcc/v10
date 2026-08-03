import { describe, expect, it, vi } from 'vitest';
import type { MoqTrack } from '../../../media/moq/parse-catalog';
import { REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
import type { MoqtObject } from '../../../network/moqt/object-stream';
import type { MoqtSession, SubscriptionHandlers } from '../../../network/moqt/session';
import { createTrackSubscriberActor } from '../track-subscriber';

// ============================================================================
// Fakes
// ============================================================================

interface FakeSubscription {
  options: { trackNamespace: string[]; trackName: string; parameters?: unknown };
  handlers: SubscriptionHandlers;
  cancelled: boolean;
  requestId: number;
}

function createFakeSession() {
  const subscriptions: FakeSubscription[] = [];
  let nextRequestId = 0;
  const session = {
    ready: Promise.resolve(),
    subscribe(options: FakeSubscription['options'], handlers: SubscriptionHandlers = {}) {
      const record: FakeSubscription = { options, handlers, cancelled: false, requestId: nextRequestId };
      nextRequestId += 2;
      subscriptions.push(record);
      return {
        requestId: record.requestId,
        update: () => {},
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
    fetch: () => ({ requestId: 0, cancel: () => {} }),
    trackStatus: () => {},
    close: () => {},
    destroy: () => {},
  } as unknown as MoqtSession;
  return { session, subscriptions };
}

const TRACK: MoqTrack = {
  type: 'video',
  id: 'live/video',
  url: 'moqt://relay/live#msf:live--video',
  mimeType: 'video/loc',
  bandwidth: 1_000_000,
  codecs: ['avc1.64001f'],
  deliveryMode: 'push',
  moq: { namespace: ['live'], name: 'video', packaging: 'loc', isLive: true },
};

function locObject(groupId: number, objectId: number, timestampUs: number): MoqtObject {
  return {
    groupId,
    objectId,
    subgroupId: 0,
    status: 'normal',
    properties: [{ type: 0x06, value: timestampUs }],
    payload: new Uint8Array([groupId, objectId]),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createTrackSubscriberActor', () => {
  it('subscribes to the track with the live-edge filter by default', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.options).toMatchObject({
      trackNamespace: ['live'],
      trackName: 'video',
      parameters: { locationFilter: { type: 'largest-object' } },
    });
    expect(subscriber.snapshot.get().context.status).toBe('pending');

    subscriber.destroy();
    expect(subscriptions[0]!.cancelled).toBe(true);
  });

  it('buffers frames in (group, object) order despite out-of-order arrival', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 1, 2_000));
    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(42, 0, 3_000));

    expect(subscriber.dequeue()).toMatchObject({ groupId: 41, objectId: 0, isKey: true });
    expect(subscriber.dequeue()).toMatchObject({ groupId: 41, objectId: 1, isKey: false });
    expect(subscriber.dequeue()).toMatchObject({ groupId: 42, objectId: 0, isKey: true });
    expect(subscriber.dequeue()).toBeUndefined();

    subscriber.destroy();
  });

  it('tracks buffer stats and decodability on the snapshot', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 1, 2_000)); // mid-group: not decodable yet
    expect(subscriber.snapshot.get().context).toMatchObject({
      status: 'active',
      hasDecodableFrame: false,
      frameCount: 1,
      latestGroupId: 41,
    });

    handlers.onObject?.(locObject(42, 0, 3_000)); // keyframe
    expect(subscriber.snapshot.get().context).toMatchObject({
      hasDecodableFrame: true,
      frameCount: 2,
      newestTimestampUs: 3_000,
      latestGroupId: 42,
    });

    subscriber.dequeue();
    expect(subscriber.snapshot.get().context.frameCount).toBe(1);

    subscriber.destroy();
  });

  it('skips to the latest keyframe-led group on catch-up', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(41, 1, 2_000));
    handlers.onObject?.(locObject(42, 0, 3_000));
    handlers.onObject?.(locObject(42, 1, 4_000));

    expect(subscriber.skipToLatestGroup()).toBe(2);
    expect(subscriber.peek()).toMatchObject({ groupId: 42, objectId: 0 });

    subscriber.destroy();
  });

  it('accumulates cumulative arrival totals for bandwidth sampling', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(41, 1, 2_000));

    // Totals are cumulative (not per-object) so a batched observer that
    // only sees the latest snapshot still accounts for every arrival. The
    // first object only establishes the timing baseline — its bytes have
    // no arrival interval, so counting them would overstate throughput.
    const arrivals = subscriber.snapshot.get().context.arrivals!;
    expect(arrivals.seq).toBe(2);
    expect(arrivals.totalBytes).toBe(2); // second 2-byte locObject payload
    expect(arrivals.totalDurationMs).toBeGreaterThanOrEqual(0);

    subscriber.destroy();
  });

  // The arrival-offset envelope is the jitter primitive the adaptive
  // latency controller reads. The offsets themselves mix two unrelated
  // clock epochs, so only their *spread* means anything — and the bounds
  // have to forget, or one lucky early frame pins the estimate forever.
  it('publishes a decaying arrival-offset envelope', () => {
    const now = vi.spyOn(performance, 'now');
    const { session, subscriptions } = createFakeSession();
    now.mockReturnValue(0);
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;
    const jitter = () => subscriber.snapshot.get().context.arrivalJitter!;

    // Media time in microseconds, arrival in wall milliseconds, 30fps.
    // Every frame is delivered 100ms "after" its own timestamp except
    // frame 1, which is 40ms later still.
    const deliver = (index: number, lateMs = 0) => {
      now.mockReturnValue(100 + index * (1000 / 30) + lateMs);
      handlers.onObject?.(locObject(1, index, Math.round((index * 1_000_000) / 30)));
    };

    deliver(0);
    expect(jitter()).toEqual({ minOffsetMs: 100, maxOffsetMs: 100, sampleCount: 1 });

    deliver(1, 40);
    expect(jitter().sampleCount).toBe(2);
    // Not exactly 40: the bounds have already relaxed over the 73ms
    // between the two arrivals, which is the mechanism working.
    expect(jitter().maxOffsetMs - jitter().minOffsetMs).toBeGreaterThan(38);
    expect(jitter().maxOffsetMs - jitter().minOffsetMs).toBeLessThanOrEqual(40);

    // A long run of well-behaved arrivals pulls the stale high bound back
    // down rather than holding the spread open indefinitely — an
    // unbounded max (or min) is what makes this class of estimate drift
    // permanently pessimistic.
    for (let i = 2; i < 300; i++) deliver(i);
    expect(jitter().maxOffsetMs - jitter().minOffsetMs).toBeLessThan(5);

    subscriber.destroy();
    now.mockRestore();
  });

  it('discards late objects at or behind the drain watermark', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(41, 1, 2_000));
    subscriber.dequeue();
    subscriber.dequeue();

    // Late arrivals behind what the consumer already took must not
    // reintroduce an already-consumed prefix at the head of the buffer.
    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(40, 5, 500));
    expect(subscriber.peek()).toBeUndefined();
    expect(subscriber.snapshot.get().context.frameCount).toBe(0);

    // Objects past the watermark still buffer.
    handlers.onObject?.(locObject(41, 2, 3_000));
    expect(subscriber.peek()).toMatchObject({ groupId: 41, objectId: 2 });

    subscriber.destroy();
  });

  it('discards stragglers from groups dropped by skipToLatestGroup', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 0, 1_000));
    handlers.onObject?.(locObject(41, 1, 2_000));
    handlers.onObject?.(locObject(42, 0, 3_000));
    expect(subscriber.skipToLatestGroup()).toBe(2);

    // A subgroup stream from the skipped group finishing late must not
    // land ahead of the keyframe the jump kept.
    handlers.onObject?.(locObject(41, 2, 2_500));
    expect(subscriber.peek()).toMatchObject({ groupId: 42, objectId: 0 });
    expect(subscriber.snapshot.get().context.frameCount).toBe(1);

    subscriber.destroy();
  });

  it('rescales timestamps with the catalog timescale', () => {
    const { session, subscriptions } = createFakeSession();
    const track: MoqTrack = { ...TRACK, moq: { ...TRACK.moq, timescale: 90_000 } };
    const subscriber = createTrackSubscriberActor({ session, track });

    subscriptions[0]!.handlers.onObject?.(locObject(1, 0, 90_000));
    expect(subscriber.peek()?.timestampUs).toBe(1_000_000);

    subscriber.destroy();
  });

  it('transitions to ended on PUBLISH_DONE and error on REQUEST_ERROR', () => {
    const { session, subscriptions } = createFakeSession();
    const first = createTrackSubscriberActor({ session, track: TRACK });
    subscriptions[0]!.handlers.onDone?.({ statusCode: 0x2, streamCount: 3, reason: 'track ended' });
    expect(first.snapshot.get().context.status).toBe('ended');
    first.destroy();

    const second = createTrackSubscriberActor({ session, track: TRACK });
    subscriptions[1]!.handlers.onError?.({ errorCode: 0x10, retryInterval: 0, reason: 'gone' });
    expect(second.snapshot.get().context.status).toBe('error');
    second.destroy();
  });

  it('refreshes auth and resubscribes once on EXPIRED_AUTH_TOKEN', async () => {
    const { session, subscriptions } = createFakeSession();
    const refreshAuth = vi.fn(async () => ({ authorizationTokens: [new Uint8Array([1])] }));
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, refreshAuth });

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 1,
      reason: 'expired',
    });

    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(subscriber.snapshot.get().context.status).not.toBe('error');

    // A second expiry is terminal (no retry storm).
    subscriptions[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 1,
      reason: 'expired again',
    });
    await vi.waitFor(() => expect(subscriber.snapshot.get().context.status).toBe('error'));
    expect(subscriptions).toHaveLength(2);

    subscriber.destroy();
  });

  it('errors when auth refresh gives up, without a stale-token retry', async () => {
    const { session, subscriptions } = createFakeSession();
    const refreshAuth = vi.fn(async (): Promise<never> => {
      throw new Error('no fresh token');
    });
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, refreshAuth });

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 1,
      reason: 'expired',
    });

    await vi.waitFor(() => expect(subscriber.snapshot.get().context.status).toBe('error'));
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveLength(1);

    subscriber.destroy();
  });

  it('prefers the SUBSCRIBE_OK track timescale over the catalog, because it describes these bytes', () => {
    // The catalog says milliseconds; the peer serving this subscription declares
    // 90kHz. A relay converts timestamps into the timescale it declares, so the
    // transport's number is the one the objects are actually in — reading the
    // catalog here would be wrong by 90x.
    const { session, subscriptions } = createFakeSession();
    const track: MoqTrack = { ...TRACK, moq: { ...TRACK.moq, timescale: 1_000 } };
    const subscriber = createTrackSubscriberActor({ session, track });
    const { handlers } = subscriptions[0]!;

    handlers.onOk?.({ trackAlias: 0, parameters: {}, trackProperties: [{ type: 0x08, value: 90_000 }] });
    handlers.onObject?.(locObject(41, 0, 90_000));

    expect(subscriber.peek()).toMatchObject({ timestampUs: 1_000_000 });

    subscriber.destroy();
  });

  it('falls back to the catalog timescale when the peer declares none', () => {
    const { session, subscriptions } = createFakeSession();
    const track: MoqTrack = { ...TRACK, moq: { ...TRACK.moq, timescale: 1_000 } };
    const subscriber = createTrackSubscriberActor({ session, track });
    const { handlers } = subscriptions[0]!;

    handlers.onOk?.({ trackAlias: 0, parameters: {}, trackProperties: [] });
    handlers.onObject?.(locObject(41, 0, 1_000));

    expect(subscriber.peek()).toMatchObject({ timestampUs: 1_000_000 });

    subscriber.destroy();
  });
});
