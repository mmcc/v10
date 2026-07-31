import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { MoqTrack } from '../../../media/moq/parse-catalog';
import type { TrackSubscriberActor, TrackSubscriberContext } from '../../actors/track-subscriber';
import type { PlayoutState } from '../sync-latency';
import { syncLatency } from '../sync-latency';

function fakeSubscriber(targetLatencyMs?: number) {
  const track = {
    type: 'audio',
    id: 'live/audio',
    url: 'moqt://relay/live#msf:live--audio',
    mimeType: 'audio/loc',
    bandwidth: 32_000,
    codecs: ['opus'],
    groupId: 'audio',
    name: 'audio',
    sampleRate: 48_000,
    channels: 2,
    deliveryMode: 'push',
    moq: { namespace: ['live'], name: 'audio', packaging: 'loc', isLive: true, targetLatency: targetLatencyMs },
  } as MoqTrack;

  const snapshot = signal({
    value: 'active' as const,
    context: { status: 'active', hasDecodableFrame: true, frameCount: 0 } as TrackSubscriberContext,
  });
  const skipToLatestGroup = vi.fn(() => 0);
  const subscriber: TrackSubscriberActor = {
    track,
    snapshot: snapshot as TrackSubscriberActor['snapshot'],
    peek: () => undefined,
    dequeue: () => undefined,
    skipToLatestGroup,
    destroy: () => {},
  };
  /**
   * Buffer whose newest frame is `seconds` ahead of playout position 0,
   * with `bufferedBehindSeconds` of already-consumed media still in the
   * jitter buffer behind it.
   */
  const setBufferDepth = (seconds: number, bufferedBehindSeconds = seconds) => {
    snapshot.set({
      value: 'active',
      context: {
        ...snapshot.get().context,
        oldestTimestampUs: (seconds - bufferedBehindSeconds) * 1_000_000,
        newestTimestampUs: seconds * 1_000_000,
        frameCount: Math.round(bufferedBehindSeconds * 30),
      },
    });
  };
  return { subscriber, setBufferDepth, skipToLatestGroup };
}

function makeDeps(subscriber: TrackSubscriberActor | undefined) {
  return {
    state: {
      targetLatency: signal<number | undefined>(undefined),
      measuredLatency: signal<number | undefined>(undefined),
      playoutRate: signal<number | undefined>(undefined),
      playoutState: signal<PlayoutState | undefined>(undefined),
      // Playout parked at 0, so `setBufferDepth(n)` reads as n seconds of
      // edge-to-playout latency.
      currentTime: signal<number | undefined>(0),
    },
    context: {
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      audioSubscriberActor: signal<TrackSubscriberActor | undefined>(subscriber),
    },
  };
}

describe('syncLatency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds rate 1 while depth is inside the deadband', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(0.6);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.measuredLatency.get()).toBeCloseTo(0.6);
    expect(deps.state.playoutRate.get()).toBe(1);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  it('nudges the rate up when the buffer runs deep, down when shallow', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(1.2); // 0.7s over target
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.playoutRate.get()).toBeCloseTo(1.05);
    expect(deps.state.playoutState.get()).toBe('nudging');

    setBufferDepth(0.1); // under target
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.playoutRate.get()).toBeCloseTo(0.95);

    reactor.destroy();
  });

  it('skips to the latest group when the buffer blows past the catch-up threshold', async () => {
    const { subscriber, setBufferDepth, skipToLatestGroup } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(5);
    await vi.advanceTimersByTimeAsync(600);

    expect(skipToLatestGroup).toHaveBeenCalled();
    expect(deps.state.playoutState.get()).toBe('catching-up');
    expect(deps.state.playoutRate.get()).toBe(1);

    reactor.destroy();
  });

  it('falls back to the catalog target latency when state has none', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber(2_000); // 2s catalog target
    const deps = makeDeps(subscriber);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(2.1); // within the 2s target's deadband
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  // The renderers hold media past the jitter buffer (video decodes ~8
  // frames ahead; audio schedules into Web Audio), so newest−oldest
  // understates real latency by everything already consumed. Measuring to
  // the playout position is what makes `measuredLatency` honest.
  it('measures the delivery edge against the playout position, not the buffer', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    // The edge is 2s ahead of playout, but only 0.1s of that is still
    // un-consumed in the jitter buffer — a depth reading would say 0.1.
    setBufferDepth(2, 0.1);
    deps.state.currentTime.set(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.measuredLatency.get()).toBeCloseTo(2);
    expect(deps.state.playoutState.get()).toBe('nudging');
    expect(deps.state.playoutRate.get()).toBeCloseTo(1.05);

    reactor.destroy();
  });

  // The old failure: a shallow buffer read as "not enough latency" and the
  // controller slowed playout down, *raising* real latency until enough
  // un-decoded backlog reappeared to satisfy the reading.
  it('holds rate 1 when latency is on target but the jitter buffer is shallow', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    // On target: playout is 0.5s behind the edge. Almost all of it is in
    // the renderer's decoded lookahead, so the buffer holds ~1 frame.
    setBufferDepth(0.5, 0.033);
    deps.state.currentTime.set(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.measuredLatency.get()).toBeCloseTo(0.5);
    expect(deps.state.playoutRate.get()).toBe(1);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  it('idles until a playout position exists', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.currentTime.set(undefined);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(5);
    await vi.advanceTimersByTimeAsync(600);

    // Nothing is being presented, so there is no latency to hold — and in
    // particular no catch-up skip fired off a buffer reading.
    expect(deps.state.measuredLatency.get()).toBeUndefined();
    expect(deps.state.playoutState.get()).toBeUndefined();

    deps.state.currentTime.set(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.measuredLatency.get()).toBeCloseTo(4);

    reactor.destroy();
  });

  it('tracks playout as it advances', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(10);
    deps.state.currentTime.set(9.6);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.measuredLatency.get()).toBeCloseTo(0.4);
    expect(deps.state.playoutState.get()).toBe('stable');

    // Playout falls behind an advancing edge: latency grows even though
    // nothing about the buffer's own span changed.
    setBufferDepth(14);
    deps.state.currentTime.set(9.6);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.measuredLatency.get()).toBeCloseTo(4.4);
    expect(deps.state.playoutState.get()).toBe('catching-up');

    reactor.destroy();
  });

  it('clears its outputs when the last subscriber goes away', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(0.5);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.playoutState.get()).toBe('stable');

    deps.context.audioSubscriberActor.set(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.playoutRate.get()).toBeUndefined();
    expect(deps.state.playoutState.get()).toBeUndefined();
    expect(deps.state.measuredLatency.get()).toBeUndefined();

    reactor.destroy();
  });
});
