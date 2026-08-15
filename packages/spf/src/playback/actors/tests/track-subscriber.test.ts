import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MoqTrack } from '../../../media/moq/parse-catalog';
import { PUBLISH_DONE_STATUS, REQUEST_ERROR_CODE } from '../../../network/moqt/control-messages';
import type { MoqtObject } from '../../../network/moqt/object-stream';
import type { MoqtSession, SubscriptionHandlers } from '../../../network/moqt/session';
import { createTrackSubscriberActor, DEFAULT_STALL_TIMEOUT_MS } from '../track-subscriber';

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
  // Only the stall-watchdog tests install a fake clock; restoring here keeps a
  // failing one from leaking it into the tests that await real microtasks.
  afterEach(() => {
    vi.useRealTimers();
  });

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

  // The edge is what join anchors and the latency controller's depth are
  // computed from. A publisher that replaces its capture source mid-stream
  // re-anchors that track's timestamps; if the re-anchor lands *behind* the
  // old timeline, a lifetime high-water mark would keep serving the departed
  // timeline's edge forever (the new timeline never climbs past it).
  it('resets the delivery edge when a frame lands a whole timeline step behind it', () => {
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK });
    const { handlers } = subscriptions[0]!;

    handlers.onObject?.(locObject(41, 0, 10_000_000));
    handlers.onObject?.(locObject(41, 1, 10_020_000));
    expect(subscriber.snapshot.get().context.newestTimestampUs).toBe(10_020_000);

    // Jitter-window reorder: a slightly older frame does not move the edge.
    handlers.onObject?.(locObject(42, 0, 10_010_000));
    expect(subscriber.snapshot.get().context.newestTimestampUs).toBe(10_020_000);

    // Timeline reset: a frame a whole discontinuity step behind adopts the
    // new timeline as the edge instead of being absorbed as a reorder.
    handlers.onObject?.(locObject(43, 0, 3_000_000));
    expect(subscriber.snapshot.get().context.newestTimestampUs).toBe(3_000_000);

    // …and the edge rises normally on the new timeline from there.
    handlers.onObject?.(locObject(43, 1, 3_020_000));
    expect(subscriber.snapshot.get().context.newestTimestampUs).toBe(3_020_000);

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
    expect(jitter()).toEqual({ minOffsetMs: 100, maxOffsetMs: 100, sampleCount: 1, epoch: 0 });

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
    // DOES_NOT_EXIST is transient (the track may appear) — recoverable.
    expect(second.snapshot.get().context.unrecoverable).toBeFalsy();
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

    // A second expiry is terminal (no retry storm) — and marked
    // unrecoverable, so recovery refuses to rebuild the same failure.
    subscriptions[1]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 1,
      reason: 'expired again',
    });
    await vi.waitFor(() => expect(subscriber.snapshot.get().context.status).toBe('error'));
    expect(subscriptions).toHaveLength(2);
    expect(subscriber.snapshot.get().context.unrecoverable).toBe(true);

    subscriber.destroy();
  });

  it('marks auth failures it cannot refresh past as unrecoverable', async () => {
    // No refresh seam: the very first expiry is already unrecoverable.
    const bare = createFakeSession();
    const noSeam = createTrackSubscriberActor({ session: bare.session, track: TRACK });
    bare.subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    expect(noSeam.snapshot.get().context.status).toBe('error');
    expect(noSeam.snapshot.get().context.unrecoverable).toBe(true);
    noSeam.destroy();

    // The provider gave up: same exhaustion, carrying the refresh error.
    const giveUp = createFakeSession();
    const refreshAuth = vi.fn(async () => {
      throw new Error('no fresh token');
    });
    const refused = createTrackSubscriberActor({ session: giveUp.session, track: TRACK, refreshAuth });
    giveUp.subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 0,
      reason: 'expired',
    });
    await vi.waitFor(() => expect(refused.snapshot.get().context.status).toBe('error'));
    expect(refused.snapshot.get().context.unrecoverable).toBe(true);
    expect(String(refused.snapshot.get().context.error)).toMatch(/no fresh token/);
    refused.destroy();
  });

  it('marks permanent rejections and auth-shaped ends as unrecoverable', () => {
    const { session, subscriptions } = createFakeSession();

    // UNAUTHORIZED answers an identical retry identically.
    const refused = createTrackSubscriberActor({ session, track: TRACK });
    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.UNAUTHORIZED,
      retryInterval: 0,
      reason: 'wrong claims',
    });
    expect(refused.snapshot.get().context.status).toBe('error');
    expect(refused.snapshot.get().context.unrecoverable).toBe(true);
    refused.destroy();

    // An auth-shaped PUBLISH_DONE: the replacement would carry the same
    // credentials the relay just rejected.
    const authEnded = createTrackSubscriberActor({ session, track: TRACK });
    subscriptions[1]!.handlers.onDone?.({
      statusCode: PUBLISH_DONE_STATUS.UNAUTHORIZED,
      streamCount: 0,
      reason: 'unauthorized',
    });
    expect(authEnded.snapshot.get().context.status).toBe('ended');
    expect(authEnded.snapshot.get().context.unrecoverable).toBe(true);
    authEnded.destroy();

    // TRACK_ENDED is the ordinary broadcaster blip — fully recoverable.
    const blipped = createTrackSubscriberActor({ session, track: TRACK });
    subscriptions[2]!.handlers.onDone?.({
      statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED,
      streamCount: 0,
      reason: 'broadcast ended',
    });
    expect(blipped.snapshot.get().context.status).toBe('ended');
    expect(blipped.snapshot.get().context.unrecoverable).toBeFalsy();
    blipped.destroy();
  });

  // The outage between the two subscriptions is not delivery time, and both
  // arrival measurements read the interval since the previous arrival as
  // exactly that — each wrong in the direction that hides the failure.
  it('re-baselines the arrival measurements across an auth-expiry resubscribe', async () => {
    const now = vi.spyOn(performance, 'now');
    const { session, subscriptions } = createFakeSession();
    const refreshAuth = vi.fn(async () => ({ authorizationTokens: [new Uint8Array([1])] }));
    now.mockReturnValue(0);
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, refreshAuth });

    // 30fps arrivals, each delivered 100ms after its own timestamp, with
    // one 40ms late — a small but real spread the controller can read.
    const deliver = (index: number, lateMs = 0) => {
      now.mockReturnValue(100 + index * (1000 / 30) + lateMs);
      subscriptions[0]!.handlers.onObject?.(locObject(1, index, Math.round((index * 1_000_000) / 30)));
    };
    deliver(0);
    for (let i = 1; i < 60; i++) deliver(i, i % 10 === 0 ? 40 : 0);
    const beforeSpread =
      subscriber.snapshot.get().context.arrivalJitter!.maxOffsetMs -
      subscriber.snapshot.get().context.arrivalJitter!.minOffsetMs;
    expect(beforeSpread).toBeGreaterThan(5);
    const beforeArrivals = subscriber.snapshot.get().context.arrivals!;

    subscriptions[0]!.handlers.onError?.({
      errorCode: REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN,
      retryInterval: 1,
      reason: 'expired',
    });
    await vi.waitFor(() => expect(subscriptions).toHaveLength(2));

    // The refresh round trip took 20s — several times the envelope's 4s
    // time constant, and far longer than any arrival interval.
    now.mockReturnValue(22_000);
    subscriptions[1]!.handlers.onObject?.(locObject(2, 0, 21_900_000));

    const jitter = subscriber.snapshot.get().context.arrivalJitter!;
    // Counted against the outage, the relaxation factor is ~1 and both
    // bounds collapse onto this one sample: a spread of 0 published in the
    // moment just after the path failed, which is where the adaptive
    // controller would propose its lowest target. Re-baselined instead, so
    // the warm-up gate holds until the new subscription has described
    // itself — the same treatment a subscriber handoff gets.
    expect(jitter.sampleCount).toBe(1);
    // And the restart is stated rather than left to be inferred from the
    // count: a reader sampling on its own timer cannot see a count fall if
    // enough frames arrive before its next read, so the envelope carries the
    // epoch it belongs to.
    expect(jitter.epoch).toBe(1);
    // The outage must not land in the throughput totals either: folded into
    // `totalDurationMs` against one object's bytes it is a single
    // arbitrarily low outlier for the bandwidth estimator.
    const arrivals = subscriber.snapshot.get().context.arrivals!;
    expect(arrivals.totalDurationMs).toBe(beforeArrivals.totalDurationMs);
    expect(arrivals.totalBytes).toBe(beforeArrivals.totalBytes);

    subscriber.destroy();
    now.mockRestore();
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

  // Data-starvation watchdog. A live MSF media track delivers continuously,
  // so a subscription that stays silent past the deadline is dead in a way
  // the wire never said — neither PUBLISH_DONE nor REQUEST_ERROR reports a
  // relay that lost its publisher or a half-closed path.
  //
  // `performance.now()` stays real throughout: the fake clock drives the
  // deadline, and the arrival measurements it feeds are asserted elsewhere.
  it('cancels the subscription and errors when the track delivers no objects', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 100 });

    // Armed by the subscribe itself, so the deadline also covers a
    // subscription that OKs and then never delivers.
    await vi.advanceTimersByTimeAsync(99);
    expect(subscriber.snapshot.get().context.status).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const { status, error } = subscriber.snapshot.get().context;
    expect(status).toBe('error');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no objects/);
    // Cancelled as well as reported: nothing else is going to tear down a
    // subscription the peer still believes is live.
    expect(subscriptions[0]!.cancelled).toBe(true);

    subscriber.destroy();
  });

  it('re-arms the stall deadline on every delivered object', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 100 });
    const { handlers } = subscriptions[0]!;

    await vi.advanceTimersByTimeAsync(60);
    handlers.onObject?.(locObject(41, 0, 1_000));
    // 120ms since the subscribe but only 60ms since delivery: the deadline
    // measures silence, not subscription age.
    await vi.advanceTimersByTimeAsync(60);
    expect(subscriber.snapshot.get().context.status).toBe('active');
    expect(subscriptions[0]!.cancelled).toBe(false);

    // A full deadline of silence after the last object is what trips it.
    await vi.advanceTimersByTimeAsync(100);
    expect(subscriber.snapshot.get().context.status).toBe('error');
    expect(subscriptions[0]!.cancelled).toBe(true);

    subscriber.destroy();
  });

  // The jitter buffer drops status-only objects, but they are still proof the
  // path is delivering — so the re-arm happens before any filtering.
  it('re-arms on status-only objects the jitter buffer ignores', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(60);
    subscriptions[0]!.handlers.onObject?.({
      groupId: 41,
      objectId: 2,
      subgroupId: 0,
      status: 'end-of-group',
      properties: [],
      payload: new Uint8Array(0),
    });
    await vi.advanceTimersByTimeAsync(60);

    expect(subscriber.snapshot.get().context.frameCount).toBe(0);
    expect(subscriber.snapshot.get().context.status).not.toBe('error');
    expect(subscriptions[0]!.cancelled).toBe(false);

    subscriber.destroy();
  });

  it('never arms the watchdog when stallTimeoutMs is 0', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 0 });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS * 2);
    expect(subscriber.snapshot.get().context.status).toBe('pending');
    expect(subscriptions[0]!.cancelled).toBe(false);

    subscriber.destroy();
  });

  it('disarms the watchdog on PUBLISH_DONE, so an ended track is not reported as stalled', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 100 });

    subscriptions[0]!.handlers.onDone?.({ statusCode: 0x2, streamCount: 3, reason: 'track ended' });
    expect(subscriber.snapshot.get().context.status).toBe('ended');
    expect(vi.getTimerCount()).toBe(0);

    // A track that said it was finished must not be overwritten with an
    // error by its own pending deadline.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscriber.snapshot.get().context.status).toBe('ended');
    expect(subscriber.snapshot.get().context.error).toBeUndefined();

    subscriber.destroy();
  });

  it('disarms the watchdog on destroy, so a torn-down subscriber never transitions late', async () => {
    vi.useFakeTimers();
    const { session, subscriptions } = createFakeSession();
    const subscriber = createTrackSubscriberActor({ session, track: TRACK, stallTimeoutMs: 100 });

    subscriber.destroy();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscriber.snapshot.get()).toMatchObject({ value: 'destroyed', context: { status: 'pending' } });
    expect(subscriptions[0]!.cancelled).toBe(true);

    // Idempotent: a second teardown after the deadline lapsed is a no-op.
    expect(() => subscriber.destroy()).not.toThrow();
  });
});
