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
      adaptiveTargetLatency: signal<number | undefined>(undefined),
      effectiveTargetLatency: signal<number | undefined>(undefined),
      catchUpSkips: signal<number | undefined>(undefined),
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

  // The transform shape: something upstream re-encodes video and passes audio
  // through, so video's delivery edge trails audio's by that pipeline's group of
  // pictures — near a second — while both tracks are live. Audio drives
  // `currentTime`, so video's trailing edge must not set the reading: subtracting
  // an audio playout position from a video edge understates latency by the whole
  // GOP and steers the rate at a gap that is not there.
  it('measures depth from audio when the video edge trails it', async () => {
    const audio = fakeSubscriber();
    const video = fakeSubscriber();
    const deps = makeDeps(audio.subscriber);
    deps.context.videoSubscriberActor.set(video.subscriber);
    deps.state.targetLatency.set(1.3);

    // Audio is an honest 1.3s behind live; video's edge is one GOP back of it.
    audio.setBufferDepth(1.3);
    video.setBufferDepth(0.3);

    const reactor = syncLatency.setup(deps);
    await vi.advanceTimersByTimeAsync(500);

    // The audio clock's own reality — not video's 0.3, which reads a second
    // short of target and would nudge the rate down to chase it.
    expect(deps.state.measuredLatency.get()).toBeCloseTo(1.3, 3);
    expect(deps.state.playoutRate.get()).toBe(1);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  // The cost of following the clock owner rather than the deepest track, kept
  // deliberately: audio's newest sitting at the playout position means the clock
  // is about to underrun, whatever video has banked, and slowing playout to
  // refill is the right response to that. This case is not evidence for measuring
  // video — video's edge says nothing about the clock audio is driving.
  it('reads a drained clock-owner buffer as starved even when video is deep', async () => {
    const audio = fakeSubscriber();
    const video = fakeSubscriber();
    const deps = makeDeps(audio.subscriber);
    deps.context.videoSubscriberActor.set(video.subscriber);
    deps.state.targetLatency.set(1.5);

    video.setBufferDepth(1.5);
    audio.setBufferDepth(0);

    const reactor = syncLatency.setup(deps);
    await vi.advanceTimersByTimeAsync(500);

    expect(deps.state.measuredLatency.get()).toBeCloseTo(0, 3);
    expect(deps.state.playoutRate.get()).toBeCloseTo(0.95);
    expect(deps.state.playoutState.get()).toBe('nudging');

    reactor.destroy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // `targetLatency` is per-track and nothing requires two tracks of one
  // broadcast to declare the same one. Measuring video-first while resolving
  // the target audio-first held a setpoint against a measurement taken
  // somewhere else — and the video renderer's clock, which resolves the
  // target from the video subscriber, would slew toward a third number.
  it('resolves the catalog target from the track the depth is measured on', async () => {
    const audio = fakeSubscriber(3_000); // audio declares a 3s target
    const video = fakeSubscriber(1_000); // video declares 1s
    const deps = makeDeps(audio.subscriber);
    deps.context.videoSubscriberActor.set(video.subscriber);

    audio.setBufferDepth(3);
    video.setBufferDepth(1); // video's edge trails, and declares its own target

    const reactor = syncLatency.setup(deps);
    await vi.advanceTimersByTimeAsync(600);

    // Depth comes from audio, so the setpoint does too — and an audio buffer
    // sitting exactly on audio's own target is stable rather than 2s deep
    // against video's.
    expect(deps.state.effectiveTargetLatency.get()).toBe(3);
    expect(deps.state.measuredLatency.get()).toBeCloseTo(3, 3);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  // Audio-only: audio is the clock and its buffer the only signal, so it
  // supplies both.
  it('resolves the audio catalog target for an audio-only broadcast', async () => {
    const audio = fakeSubscriber(3_000);
    const deps = makeDeps(audio.subscriber);

    audio.setBufferDepth(3);

    const reactor = syncLatency.setup(deps);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.effectiveTargetLatency.get()).toBe(3);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  // Video-only: no audio renderer, so `trackPlayoutTime` clocks off the video
  // renderer's presented frame and video's buffer is the only signal — it
  // supplies both, which is why video is the fallback rather than the default.
  it('resolves the video catalog target for a video-only broadcast', async () => {
    const video = fakeSubscriber(1_000);
    const deps = makeDeps(undefined);
    deps.context.videoSubscriberActor.set(video.subscriber);

    video.setBufferDepth(1);

    const reactor = syncLatency.setup(deps);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.effectiveTargetLatency.get()).toBe(1);
    expect(deps.state.measuredLatency.get()).toBeCloseTo(1, 3);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
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

  // Adaptive siblings. The chain above is unchanged by all of this: an
  // absent `adaptiveTargetLatency` is the same input the resolver saw
  // before the slot existed.
  it('uses the adaptive target when the consumer set none', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber(2_000); // 2s catalog target
    const deps = makeDeps(subscriber);
    deps.state.adaptiveTargetLatency.set(0.3);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(0.35);
    await vi.advanceTimersByTimeAsync(600);

    // The adaptive proposal outranks the catalog, so 0.35s is on target
    // rather than 1.65s short of it.
    expect(deps.state.effectiveTargetLatency.get()).toBe(0.3);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  it('lets an explicit consumer target beat the adaptive one', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(2);
    deps.state.adaptiveTargetLatency.set(0.2);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(2);
    await vi.advanceTimersByTimeAsync(600);

    expect(deps.state.effectiveTargetLatency.get()).toBe(2);
    expect(deps.state.playoutState.get()).toBe('stable');

    reactor.destroy();
  });

  it('publishes the resolved target for every layer of the chain', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber(2_000);
    const deps = makeDeps(subscriber);
    const reactor = syncLatency.setup(deps);

    setBufferDepth(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.effectiveTargetLatency.get()).toBe(2); // catalog

    deps.state.adaptiveTargetLatency.set(0.4);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.effectiveTargetLatency.get()).toBe(0.4); // adaptive

    deps.state.targetLatency.set(1.25);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.effectiveTargetLatency.get()).toBe(1.25); // consumer

    reactor.destroy();
  });

  it('publishes the default target with nothing else stated', async () => {
    const { subscriber } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    const reactor = syncLatency.setup(deps);

    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.effectiveTargetLatency.get()).toBe(0.5);

    reactor.destroy();
  });

  it('counts catch-up skips as the cost side of the target it is holding', async () => {
    const { subscriber, setBufferDepth } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.targetLatency.set(0.5);
    const reactor = syncLatency.setup(deps);

    expect(deps.state.catchUpSkips.get()).toBe(0);

    setBufferDepth(10);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.catchUpSkips.get()).toBe(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.catchUpSkips.get()).toBe(2);

    setBufferDepth(0.5);
    await vi.advanceTimersByTimeAsync(600);
    expect(deps.state.catchUpSkips.get()).toBe(2);

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
