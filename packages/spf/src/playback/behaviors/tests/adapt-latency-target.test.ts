import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { MoqTrack } from '../../../media/moq/parse-catalog';
import type { TrackSubscriberActor, TrackSubscriberContext } from '../../actors/track-subscriber';
import {
  adaptLatencyTarget,
  DEFAULT_ADAPTIVE_LATENCY_CONFIG,
  resolveAdaptiveLatencyConfig,
} from '../adapt-latency-target';
import type { PlayoutState } from '../sync-latency';

/**
 * `performance.now()` drives every rate limit and every window in this
 * behavior, and vitest's default fake-timer set leaves it real — which
 * would make each evaluation see zero elapsed time and no correction at
 * all.
 */
const FAKE_CLOCKS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

function fakeSubscriber(catalog?: { jitterMs?: number; targetLatencyMs?: number }) {
  const track = {
    type: 'audio',
    id: 'live/audio',
    moq: {
      namespace: ['live'],
      name: 'audio',
      packaging: 'loc',
      isLive: true,
      jitter: catalog?.jitterMs,
      targetLatency: catalog?.targetLatencyMs,
    },
  } as MoqTrack;

  const snapshot = signal({
    value: 'active' as const,
    context: { status: 'active', hasDecodableFrame: true, frameCount: 0 } as TrackSubscriberContext,
  });

  /** Publish an arrival envelope whose spread is `spreadMs`. */
  const setArrivalJitter = (spreadMs: number, sampleCount = 200) => {
    snapshot.set({
      value: 'active',
      context: {
        ...snapshot.get().context,
        arrivalJitter: { minOffsetMs: 1_000, maxOffsetMs: 1_000 + spreadMs, sampleCount },
      },
    });
  };

  const subscriber: TrackSubscriberActor = {
    track,
    snapshot: snapshot as TrackSubscriberActor['snapshot'],
    peek: () => undefined,
    dequeue: () => undefined,
    skipToLatestGroup: () => 0,
    destroy: () => {},
  };
  return { subscriber, setArrivalJitter };
}

function makeDeps(subscriber: TrackSubscriberActor | undefined) {
  return {
    state: {
      adaptiveLatencyEnabled: signal<boolean | undefined>(true),
      adaptiveTargetLatency: signal<number | undefined>(undefined),
      playoutState: signal<PlayoutState | undefined>('stable'),
      catchUpSkips: signal<number | undefined>(0),
      audioUnderruns: signal<number | undefined>(0),
      framesDropped: signal<number | undefined>(0),
    },
    context: {
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      audioSubscriberActor: signal<TrackSubscriberActor | undefined>(subscriber),
    },
  };
}

/** Defaults: 0.1s floor + 1.5 × spread. A 40ms spread proposes 0.16s. */
const WARM_MS = 4_100;

describe('adaptLatencyTarget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays inactive and registers no timer while adaptation is off', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.adaptiveLatencyEnabled.set(undefined); // defer to config, which is off
    setArrivalJitter(40);

    const reactor = adaptLatencyTarget.setup(deps);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reactor.snapshot.get().value).toBe('inactive');
    // The whole control arm of the A/B: nothing published, so every
    // reader resolves the target it resolved before this existed.
    expect(deps.state.adaptiveTargetLatency.get()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    reactor.destroy();
  });

  it('publishes nothing until the arrival window has warmed up', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40, 10); // far short of minArrivalSamples
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.state.adaptiveTargetLatency.get()).toBeUndefined();

    // Enough samples now, but the observation window still has to elapse
    // from activation — a target computed from a handful of frames is
    // worse than no target.
    setArrivalJitter(40);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(0.16, 3);

    reactor.destroy();
  });

  it('proposes the floor plus the observed arrival spread', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(200); // 0.1 + 0.2 × 1.5
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(0.4, 3);

    reactor.destroy();
  });

  it('adds the catalog jitter the publisher declared', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber({ jitterMs: 34 });
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(0.194, 3);

    reactor.destroy();
  });

  it('clamps the proposal into the configured bounds', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(10_000); // absurd spread
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBe(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxTargetLatency);

    reactor.destroy();
  });

  // An underrun is the one signal that says "the target is below what
  // this path sustains" directly; everything else is inference.
  it('widens promptly after an audio underrun', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;
    expect(settled).toBeCloseTo(0.16, 3);

    deps.state.audioUnderruns.set(1);
    // The next evaluation already moves — no waiting out a freeze — and
    // moves by the widen rate (0.02/s over a 2s cadence).
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(settled + 0.04, 3);

    // …and keeps moving toward the widened proposal on the next one.
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(settled + 0.08, 3);

    reactor.destroy();
  });

  // The mirror of the bandwidth estimator's min(fast, slow): there the
  // asymmetry protects against stalls by dropping fast, here it protects
  // against them by rising fast.
  it('narrows four times slower than it widens, and never inside the quiet window', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);
    const cadence = DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs;
    const sample = () => deps.state.adaptiveTargetLatency.get()!;

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = sample();

    deps.state.catchUpSkips.set(1);
    await vi.advanceTimersByTimeAsync(cadence);
    const widenStep = sample() - settled;
    expect(widenStep).toBeCloseTo(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxWidenRatePerSecond * (cadence / 1000), 4);

    // Inside the quiet window the bias does not bleed off, so the target
    // only ever moves one way.
    let previous = sample();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(cadence);
      expect(sample()).toBeGreaterThanOrEqual(previous);
      previous = sample();
    }
    const peak = previous;

    // Past it the bias decays and the target gives the excess back — one
    // quarter as fast, which is the whole point of the asymmetry.
    await vi.advanceTimersByTimeAsync(20_000);
    const before = sample();
    await vi.advanceTimersByTimeAsync(cadence);
    const narrowStep = before - sample();
    expect(narrowStep).toBeCloseTo(widenStep / 4, 4);
    expect(before).toBeLessThan(peak);

    // It comes to rest inside the Schmitt release band around the
    // un-widened proposal rather than overshooting back past it.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sample()).toBeGreaterThanOrEqual(settled);
    expect(sample()).toBeLessThan(settled + 0.05);

    reactor.destroy();
  });

  it('ignores a handful of late frames and reacts to a burst of them', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;

    // A busy decoder is not a starved path.
    deps.state.framesDropped.set(9);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBe(settled);

    deps.state.framesDropped.set(9 + DEFAULT_ADAPTIVE_LATENCY_CONFIG.dropsPerEvent);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBeGreaterThan(settled);

    reactor.destroy();
  });

  // `dropsPerEvent` is a threshold on the running total, not on one
  // evaluation's delta. Taking each window's quotient alone made a steady
  // trickle below the budget invisible forever — two frames a second of
  // visibly broken video that the controller reads as a clean path.
  it('accumulates late-frame drops that arrive below the budget per window', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;

    // Four drops per evaluation against a budget of ten: no single window
    // reaches an event, and three windows carry past it.
    let dropped = 0;
    for (let window = 0; window < 3; window++) {
      dropped += 4;
      deps.state.framesDropped.set(dropped);
      await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    }
    expect(dropped).toBeGreaterThanOrEqual(DEFAULT_ADAPTIVE_LATENCY_CONFIG.dropsPerEvent);
    expect(deps.state.adaptiveTargetLatency.get()).toBeGreaterThan(settled);

    reactor.destroy();
  });

  // The counters are cumulative and the latency controller has usually
  // been running a while before adaptation is switched on.
  it('baselines the failure counters at activation instead of replaying them', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    deps.state.catchUpSkips.set(12);
    deps.state.audioUnderruns.set(4);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    // Floor + spread only: none of the pre-existing history widened it.
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(0.16, 3);

    reactor.destroy();
  });

  it('holds the setpoint still while the latency controller is not stable', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;

    // Mid-correction: the inner loop is already steering toward this
    // setpoint, and moving it underneath is the documented hunting
    // failure. Even a definite underrun waits.
    deps.state.playoutState.set('nudging');
    deps.state.audioUnderruns.set(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(deps.state.adaptiveTargetLatency.get()).toBe(settled);

    deps.state.playoutState.set('stable');
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBeGreaterThan(settled);

    reactor.destroy();
  });

  // A quality switch swaps the subscriber actor, and with it the arrival
  // envelope. Dropping back to the fallback chain would be a setpoint
  // step, which is the one thing this controller must never produce.
  it('holds the last proposal across a subscriber handoff', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;

    const next = fakeSubscriber();
    next.setArrivalJitter(40, 0);
    deps.context.audioSubscriberActor.set(next.subscriber);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBe(settled);

    reactor.destroy();
  });

  // The same fresh epoch, arriving without an actor swap: the auth-expiry
  // resubscribe drops the subscriber's arrival baseline, so the envelope
  // restarts on the very object the controller is already watching. Only the
  // sample count re-arms by itself — the observation window kept counting
  // from an epoch that had ended, so 60 quick post-reconnect frames satisfied
  // both halves of the gate with under a second of new observation behind
  // them, and the moment just after a path failure is when its envelope reads
  // narrowest.
  it('re-baselines the observation window when the arrival envelope restarts', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(200);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    const settled = deps.state.adaptiveTargetLatency.get()!;
    expect(settled).toBeCloseTo(0.4, 3);

    // Reconnected: one frame establishes the new baseline, and a jitter-free
    // envelope is what a single sample always looks like.
    setArrivalJitter(0, 1);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);

    // The count is back over the threshold well inside `warmupSeconds`.
    setArrivalJitter(0, DEFAULT_ADAPTIVE_LATENCY_CONFIG.minArrivalSamples);
    await vi.advanceTimersByTimeAsync(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs);
    expect(deps.state.adaptiveTargetLatency.get()).toBe(settled);

    // And once the window really has elapsed the reconnected path speaks for
    // itself, narrowing from the held proposal rather than stepping to it.
    await vi.advanceTimersByTimeAsync(20_000);
    const narrowed = deps.state.adaptiveTargetLatency.get()!;
    expect(narrowed).toBeLessThan(settled);
    expect(narrowed).toBeGreaterThan(DEFAULT_ADAPTIVE_LATENCY_CONFIG.minTargetLatency);

    reactor.destroy();
  });

  it('clears its proposal when the last subscriber goes away', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBeDefined();

    deps.context.audioSubscriberActor.set(undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.adaptiveTargetLatency.get()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    reactor.destroy();
  });

  it('switches off at runtime through the state slot', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup(deps);

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBeDefined();

    deps.state.adaptiveLatencyEnabled.set(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(reactor.snapshot.get().value).toBe('inactive');
    expect(deps.state.adaptiveTargetLatency.get()).toBeUndefined();

    reactor.destroy();
  });

  it('honours a config-level enable with no state override', async () => {
    const { subscriber, setArrivalJitter } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    deps.state.adaptiveLatencyEnabled.set(undefined);
    setArrivalJitter(40);
    const reactor = adaptLatencyTarget.setup({ ...deps, config: { adaptiveLatency: { enabled: true } } });

    await vi.advanceTimersByTimeAsync(WARM_MS);
    expect(deps.state.adaptiveTargetLatency.get()).toBeCloseTo(0.16, 3);

    reactor.destroy();
  });
});

describe('resolveAdaptiveLatencyConfig', () => {
  it('derives defaults that satisfy the timescale bounds for any latency tuning', () => {
    // A parked controller (a test harness disabling the inner loop) must
    // not make this behavior's presence in the composition a hazard.
    const parked = resolveAdaptiveLatencyConfig({ latency: { intervalMs: 60_000 } });
    expect(parked.adaptive.intervalMs).toBe(240_000);

    const slowSlew = resolveAdaptiveLatencyConfig({ latency: { clockSlewRate: 0.01 } });
    expect(slowSlew.adaptive.maxWidenRatePerSecond).toBeLessThan(0.01 / 2);
    expect(slowSlew.adaptive.maxNarrowRatePerSecond).toBeLessThan(slowSlew.adaptive.maxWidenRatePerSecond);
  });

  // 50ms of target movement per 2s is 0.025 — half the 0.05 slew budget,
  // and fine. The same 50ms per 500ms is 0.1, double the budget, and the
  // slew never settles onto a goal moving that fast.
  it('throws on an explicit widen rate the inner loops cannot follow', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxWidenRatePerSecond: 0.1 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxWidenRatePerSecond: 0.02 } })).not.toThrow();
    expect(() =>
      resolveAdaptiveLatencyConfig({
        latency: { clockSlewRate: 0.02 },
        adaptiveLatency: { maxWidenRatePerSecond: 0.02 },
      })
    ).toThrow(RangeError);
  });

  it('throws on an explicit narrow rate the inner loops cannot follow', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxNarrowRatePerSecond: 0.5 } })).toThrow(
      RangeError
    );
  });

  it('throws when the outer loop would run faster than 4× the inner one', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { intervalMs: 1_000 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { intervalMs: 2_000 } })).not.toThrow();
    expect(() =>
      resolveAdaptiveLatencyConfig({ latency: { intervalMs: 250 }, adaptiveLatency: { intervalMs: 1_000 } })
    ).not.toThrow();
  });

  // The budget checks are upper bounds, so a broken rate passes them: the
  // step is signed by the error rather than by the rate, and a negative one
  // walks the setpoint away from the proposal it was computed to reach.
  it('throws on a rate that is not a finite non-negative magnitude', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxWidenRatePerSecond: -0.01 } })).toThrow(
      RangeError
    );
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxNarrowRatePerSecond: -0.01 } })).toThrow(
      RangeError
    );
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxWidenRatePerSecond: Number.NaN } })).toThrow(
      RangeError
    );
    expect(() =>
      resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxNarrowRatePerSecond: Number.NEGATIVE_INFINITY } })
    ).toThrow(RangeError);
    // Zero is a legitimate "hold this direction still".
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { maxWidenRatePerSecond: 0 } })).not.toThrow();
  });

  // `Math.floor(delta / dropsPerEvent)`: zero makes one dropped frame an
  // unbounded number of failure events and pins widenBias at its ceiling,
  // and a negative divisor makes drops subtract events.
  it('throws on a drop budget that cannot divide into events', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 0 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: -10 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: Number.NaN } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 1 } })).not.toThrow();
  });

  // The same failure the other way up: a divisor below 1 divides *up*, so
  // one dropped frame becomes several failure events. Measured on the
  // behavior with the default tuning, a single drop peaked the published
  // target at 0.28s with a budget of 1, 0.40s at 0.5 and 0.84s at 0.1 —
  // against 0.16s (no event at all) at the default budget of 10.
  it('throws on a fractional drop budget, which divides one drop into several events', () => {
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 0.5 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 0.1 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 10.5 } })).toThrow(RangeError);
    expect(() => resolveAdaptiveLatencyConfig({ adaptiveLatency: { dropsPerEvent: 10 } })).not.toThrow();
  });

  it('throws on an inverted target range', () => {
    expect(() =>
      resolveAdaptiveLatencyConfig({ adaptiveLatency: { minTargetLatency: 2, maxTargetLatency: 1 } })
    ).toThrow(RangeError);
  });
});
