/**
 * **Propose the lowest target latency the observed path can sustain.**
 * Owns `state.adaptiveTargetLatency` (seconds), which `syncLatency` and
 * the renderers rank *below* an explicit `state.targetLatency` and *above*
 * the catalog target — so this behavior can only ever fill in where the
 * consumer stated nothing, and publishing `undefined` restores the
 * original chain exactly.
 *
 * Off by default. With `adaptiveLatency.enabled` unset (and no
 * `state.adaptiveLatencyEnabled` override) the reactor stays `inactive`:
 * no timer, no slot writes, and every reader resolves the same target it
 * resolved before this behavior existed. That is the control arm of the
 * A/B this exists to make measurable.
 *
 * ## What it can observe, and what it cannot
 *
 * There is no transport RTT here. spf speaks its own draft-19 stack (no
 * PROBE — that is a moq-lite extension) and browsers do not populate
 * `WebTransport.getStats().smoothedRtt`, so the absolute one-way delay is
 * simply not available. The no-RTT path is therefore the only path, and
 * the estimate is built from what *is* observable:
 *
 * - **Arrival jitter** (`TrackSubscriberContext.arrivalJitter`): the
 *   decaying spread between the earliest and latest recent arrival
 *   offsets. Offsets mix two unrelated clock epochs so their absolute
 *   value means nothing; their *spread* is exactly the delivery variance
 *   a jitter buffer exists to absorb, and it is the one thing a receiver
 *   can measure without a synchronised clock.
 * - **The publisher's declared `jitter`** (msf-01 §5.2.9, milliseconds):
 *   packaging/encode variance the observation window may not have covered
 *   yet. Additive, and only when the catalog states one.
 * - **A starting cushion** (`floorSeconds`): decode, compositing, and the
 *   controller's own sampling granularity. It is a **constant, not a
 *   derivation** — hang's precedent is the same shape (a flat 100ms
 *   fallback) and pretending otherwise would be the dishonest part.
 * - **Failure feedback**: audio underruns, catch-up skips, and late-frame
 *   drops. These are the only *direct* evidence that a target is below
 *   what the path sustains, which is why the plumbing to surface them
 *   (`trackPlayoutHealth`, `AudioRendererContext.underruns`,
 *   `syncLatency`'s `catchUpSkips`) was worth adding.
 *
 * ## Widen fast, narrow slow
 *
 * `widenBias` is an integrator over failure events, and it is the mirror
 * image of the dual-EWMA bandwidth idiom (`bandwidth-estimator`: take
 * `min(fast, slow)` so estimates fall quickly and rise slowly). Here the
 * asymmetry runs the other way — an underrun is a picture that froze, and
 * the cost of over-buffering is latency nobody dies of — so the bias
 * jumps on every event and bleeds off linearly over tens of seconds.
 *
 * ## Separation of timescales — the constraint that shapes everything
 *
 * Three negative-feedback loops act on one variable, and adaptation adds
 * the third by making the *setpoint* move:
 *
 * 1. `syncLatency`'s ±`rateNudge` bang-bang, every `latency.intervalMs`.
 * 2. The video self-clock's continuous slew onto the delivery edge, at
 *    `latency.clockSlewRate` of real time — **only** when there is no
 *    audio master clock.
 * 3. This behavior's moving setpoint.
 *
 * Both (1) and (2) are corrections toward the target, so a target that
 * moves faster than they can follow is a target they never reach. Two
 * bounds keep that from happening and both are **validated, not merely
 * documented** (`resolveAdaptiveLatencyConfig` throws):
 *
 * - `maxWidenRatePerSecond < latency.clockSlewRate / 2`. The renderers
 *   consult the edge target on every clock read, so the slew goal moves
 *   with the setpoint; at half the slew budget the clock still closes on
 *   it. Concretely: 50ms of target movement spread over 2s is 0.025, half
 *   of the 0.05 default budget — fine. The same 50ms over 500ms is 0.1,
 *   double the budget, and never settles.
 * - `intervalMs >= 4 × latency.intervalMs`. The inner loop needs several
 *   evaluations against a stationary setpoint before the outer loop moves
 *   it, or the two alias into one badly-damped loop.
 *
 * **With audio present the slew is off** and audio's join anchor only
 * applies at join or discontinuity, so a mid-playback setpoint change is
 * realized *entirely* through the bang-bang nudge — the documented
 * "latency controller hunting" failure mode. That is why widening is not
 * a step even though the evidence for it is acute: there is no mechanism
 * at either the clock or the nudge that can realize a step without
 * hunting, so "prompt" here means *begins immediately and monotonically*,
 * not *jumps*. The bias itself rises instantly; only its journey into the
 * published setpoint is rate-limited, and the acute case is meanwhile
 * handled by the nudge, which is already refilling at 5%.
 *
 * Narrowing is slower still (`maxNarrowRatePerSecond`, a quarter of the
 * widen rate) and both directions sit behind a Schmitt trigger sized off
 * `latency.deadband`: the setpoint does not begin moving until the
 * proposal is more than half a deadband away, and stops once it is within
 * a quarter. Without it the setpoint would creep continuously and the
 * nudge would never find a stationary thing to converge on.
 *
 * Adaptation also **freezes** — the published target is held, though the
 * bias keeps integrating — while `playoutState` is not `'stable'` (the
 * inner loop is mid-correction), for `freezeSeconds` after a catch-up
 * skip or an underrun, and across a subscriber handoff. Each is a moment
 * when the measurement describes the transient rather than the path.
 *
 * ## Warm-up
 *
 * Before `minArrivalSamples` arrivals *and* `warmupSeconds` of observation
 * the slot stays `undefined` and every reader falls through to the
 * existing consumer → catalog → default chain. Same discipline as
 * `hasGoodEstimate` in the bandwidth estimator: publishing a target
 * computed from three frames is worse than publishing none.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import type { TrackSubscriberActor } from '../actors/track-subscriber';
import { DEFAULT_LATENCY_CONTROL_CONFIG, type LatencyControlConfig, type PlayoutState } from './sync-latency';

// =============================================================================
// State / context / config
// =============================================================================

export interface AdaptLatencyTargetState {
  /**
   * Runtime override of `config.adaptiveLatency.enabled`, written by a
   * consumer (the element's `adaptive-latency` attribute). `undefined`
   * defers to config — the same shape `targetLatency` has against
   * `defaultTargetLatency`.
   */
  adaptiveLatencyEnabled?: boolean;
  /** This behavior's output: the proposed target in seconds. Sole writer. */
  adaptiveTargetLatency?: number;
  /** Read as a freeze gate — a non-stable controller is mid-correction. */
  playoutState?: PlayoutState;
  /** Failure feedback (see `widenBias`). */
  catchUpSkips?: number;
  audioUnderruns?: number;
  framesDropped?: number;
}

export interface AdaptLatencyTargetContext {
  videoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
}

export interface AdaptiveLatencyConfig {
  /**
   * Master switch. **False by default** — adaptation is opt-in until the
   * A/B against the fixed setpoint says otherwise.
   */
  enabled: boolean;
  /**
   * Evaluation cadence in milliseconds. An explicit value must be at
   * least 4× `latency.intervalMs` so the inner control loop settles
   * between moves; the default is raised to satisfy that automatically.
   */
  intervalMs: number;
  /** Hard floor on the proposed target, in seconds. */
  minTargetLatency: number;
  /** Hard ceiling on the proposed target, in seconds. */
  maxTargetLatency: number;
  /**
   * Constant cushion added to every proposal, in seconds: decode,
   * compositing, and this controller's own sampling granularity. Not
   * derived from anything — hang carries the same shape as a flat 100ms
   * fallback, and that is the honest description of this number too.
   */
  floorSeconds: number;
  /**
   * Multiplier on the observed arrival spread. Above 1 because the window
   * has seen a sample of the delay distribution, not its tail.
   */
  jitterSafetyFactor: number;
  /** Add the catalog's declared `jitter` (msf-01 §5.2.9) to the margin. */
  useCatalogJitter: boolean;
  /** Seconds added to `widenBias` per failure event. */
  widenStep: number;
  /** Ceiling on `widenBias`, in seconds. */
  widenMax: number;
  /** Seconds of `widenBias` shed per second without a failure event. */
  widenDecayPerSecond: number;
  /**
   * Maximum rate the published target may *increase*, as seconds of
   * target per second of real time. An explicit value is validated
   * against half the slower of `latency.clockSlewRate` and
   * `latency.rateNudge`; the default is lowered to satisfy it.
   */
  maxWidenRatePerSecond: number;
  /** Maximum rate the published target may *decrease*. */
  maxNarrowRatePerSecond: number;
  /** Arrivals required on the controlled track before publishing anything. */
  minArrivalSamples: number;
  /** Seconds of observation required before publishing anything. */
  warmupSeconds: number;
  /** Seconds adaptation is frozen after a failure event or a handoff. */
  freezeSeconds: number;
}

export const DEFAULT_ADAPTIVE_LATENCY_CONFIG: AdaptiveLatencyConfig = {
  enabled: false,
  // 4× the 500ms controller cadence — the validated minimum, and the
  // slowest useful outer loop.
  intervalMs: 2_000,
  // Below ~100ms nothing in this pipeline is reachable: the render hop
  // alone spends more than that, and an unreachable target pins the nudge
  // at 0.95 forever.
  minTargetLatency: 0.1,
  // Above the default 3s catch-up threshold the controller would be
  // skipping on a stream that is merely deep; 4s is generous for a bad
  // WAN and still bounded.
  maxTargetLatency: 4,
  floorSeconds: 0.1,
  jitterSafetyFactor: 1.5,
  useCatalogJitter: true,
  // One event ≈ one GOP of extra cushion. Sized to be felt, since the
  // rate limit below spreads it over several seconds anyway.
  widenStep: 0.15,
  widenMax: 1,
  // From `widenMax` back to zero in ~50s of clean playback: long enough
  // that a flaky minute does not evaporate between spikes.
  widenDecayPerSecond: 0.02,
  // Strictly below DEFAULT_LATENCY_CONTROL_CONFIG.clockSlewRate / 2 = 0.025.
  maxWidenRatePerSecond: 0.02,
  maxNarrowRatePerSecond: 0.005,
  // ~2s of 30fps video, or ~1.3s of 48kHz AAC.
  minArrivalSamples: 60,
  warmupSeconds: 3,
  freezeSeconds: 5,
};

export interface AdaptLatencyTargetConfig {
  /** Shared with `syncLatency` and the renderers — read for its timescale bounds. */
  latency?: Partial<LatencyControlConfig>;
  adaptiveLatency?: Partial<AdaptiveLatencyConfig>;
}

/**
 * How much of real time the inner loops can spend correcting toward the
 * setpoint — the budget the setpoint's own movement has to stay inside.
 *
 * Which loop binds depends on the configuration: the video self-clock
 * slews at `clockSlewRate`, but only while it *has* an edge target
 * (`joinAtEdge`), and the bang-bang nudge corrects at `rateNudge` always.
 * The slower of the applicable two is what a moving setpoint has to let
 * catch up.
 */
function correctionBudgetPerSecond(latency: LatencyControlConfig): number {
  const slewApplies = latency.joinAtEdge && latency.clockSlewRate > 0;
  return (slewApplies ? Math.min(latency.clockSlewRate, latency.rateNudge) : latency.rateNudge) / 2;
}

/**
 * Merge the adaptive defaults against a given latency configuration and
 * **enforce the separation-of-timescales invariants**.
 *
 * Two halves, and the split is what keeps the enforcement from being a
 * nuisance:
 *
 * - The **defaults derive from `latency`**, so an untouched adaptive
 *   config satisfies the invariants for *any* latency tuning — including
 *   one that parks the controller. A default that could throw would make
 *   this behavior's mere presence in the composition a hazard for engines
 *   that never enable it.
 * - An **explicitly supplied** value is validated and throws. It encodes
 *   a relationship between two knobs a caller set deliberately, and
 *   silently rewriting one produces a player whose latency wanders for
 *   reasons nothing reports — a control loop that never settles is
 *   precisely the class of bug that cannot be attributed after the fact.
 *
 * Exported so a host can validate a candidate configuration without
 * standing up an engine.
 */
export function resolveAdaptiveLatencyConfig(config?: AdaptLatencyTargetConfig): {
  adaptive: AdaptiveLatencyConfig;
  latency: LatencyControlConfig;
} {
  const latency: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...config?.latency };
  const supplied = config?.adaptiveLatency ?? {};
  const budget = correctionBudgetPerSecond(latency);

  const adaptive: AdaptiveLatencyConfig = {
    ...DEFAULT_ADAPTIVE_LATENCY_CONFIG,
    intervalMs: Math.max(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs, latency.intervalMs * 4),
    maxWidenRatePerSecond: Math.min(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxWidenRatePerSecond, budget * 0.8),
    maxNarrowRatePerSecond: Math.min(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxNarrowRatePerSecond, budget * 0.2),
    ...supplied,
  };

  if (supplied.maxWidenRatePerSecond !== undefined && supplied.maxWidenRatePerSecond >= budget) {
    throw new RangeError(
      `adaptiveLatency.maxWidenRatePerSecond (${supplied.maxWidenRatePerSecond}) must stay below ${budget}: half ` +
        `the slower of latency.clockSlewRate (${latency.clockSlewRate}) and latency.rateNudge ` +
        `(${latency.rateNudge}). A setpoint that moves faster than the loops correcting toward it never settles.`
    );
  }
  if (supplied.maxNarrowRatePerSecond !== undefined && supplied.maxNarrowRatePerSecond >= budget) {
    throw new RangeError(
      `adaptiveLatency.maxNarrowRatePerSecond (${supplied.maxNarrowRatePerSecond}) must stay below ${budget}: half ` +
        `the slower of latency.clockSlewRate (${latency.clockSlewRate}) and latency.rateNudge ` +
        `(${latency.rateNudge}).`
    );
  }
  const minInterval = latency.intervalMs * 4;
  if (supplied.intervalMs !== undefined && supplied.intervalMs < minInterval) {
    throw new RangeError(
      `adaptiveLatency.intervalMs (${supplied.intervalMs}) must be at least 4× latency.intervalMs ` +
        `(${latency.intervalMs} → ${minInterval}ms): the latency controller needs several evaluations against a ` +
        'stationary setpoint before the setpoint moves again.'
    );
  }
  if (adaptive.minTargetLatency > adaptive.maxTargetLatency) {
    throw new RangeError(
      `adaptiveLatency.minTargetLatency (${adaptive.minTargetLatency}) must not exceed maxTargetLatency ` +
        `(${adaptive.maxTargetLatency}).`
    );
  }
  return { adaptive, latency };
}

// =============================================================================
// Implementation
// =============================================================================

type FsmState = 'inactive' | 'adapting';

/**
 * Increase in a monotonic counter since `previous`. A counter that went
 * away (`undefined`) or restarted lower is a fresh owner — the controller
 * re-baselines rather than counting the discontinuity as events.
 */
function counterDelta(previous: number, next: number | undefined): number {
  if (next === undefined || next < previous) return 0;
  return next - previous;
}

function setupAdaptLatencyTarget({
  state,
  context,
  config,
}: {
  state: {
    adaptiveLatencyEnabled: ReadonlySignal<AdaptLatencyTargetState['adaptiveLatencyEnabled']>;
    adaptiveTargetLatency: Signal<AdaptLatencyTargetState['adaptiveTargetLatency']>;
    playoutState: ReadonlySignal<AdaptLatencyTargetState['playoutState']>;
    catchUpSkips: ReadonlySignal<AdaptLatencyTargetState['catchUpSkips']>;
    audioUnderruns: ReadonlySignal<AdaptLatencyTargetState['audioUnderruns']>;
    framesDropped: ReadonlySignal<AdaptLatencyTargetState['framesDropped']>;
  };
  context: {
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
  };
  config?: AdaptLatencyTargetConfig;
}): Reactor<FsmState | 'destroying' | 'destroyed'> {
  const { adaptive, latency } = resolveAdaptiveLatencyConfig(config);

  const enabled = computed(() => state.adaptiveLatencyEnabled.get() ?? adaptive.enabled);
  const derivedStateSignal = computed<FsmState>(() =>
    enabled.get() && (context.videoSubscriberActor.get() || context.audioSubscriberActor.get())
      ? 'adapting'
      : 'inactive'
  );

  // Schmitt trigger bounds. Sized off the controller's own deadband so the
  // setpoint only moves by amounts the inner loop would actually act on.
  const engageThreshold = latency.deadband / 2;
  const releaseThreshold = latency.deadband / 4;

  /** Per-activation controller state; reset by `entry`. */
  let widenBias = 0;
  let published: number | undefined;
  let moving = false;
  let observedSince = 0;
  let frozenUntil = 0;
  let lastSubscriber: TrackSubscriberActor | undefined;
  let lastEvaluatedAt = 0;
  let seenSkips = 0;
  let seenUnderruns = 0;
  let seenDrops = 0;

  const reset = (): void => {
    widenBias = 0;
    published = undefined;
    moving = false;
    observedSince = 0;
    frozenUntil = 0;
    lastSubscriber = undefined;
    lastEvaluatedAt = 0;
    seenSkips = 0;
    seenUnderruns = 0;
    seenDrops = 0;
    state.adaptiveTargetLatency.set(undefined);
  };

  /**
   * The track whose delivery the controller reasons about: audio when
   * there is any, because it owns the master clock and starves audibly.
   * The same preference `syncLatency` applies to its measurement.
   */
  const controlledSubscriber = (): TrackSubscriberActor | undefined =>
    peek(context.audioSubscriberActor) ?? peek(context.videoSubscriberActor);

  const evaluate = (): void => {
    const now = performance.now();
    const elapsedSeconds = lastEvaluatedAt === 0 ? 0 : Math.max(0, (now - lastEvaluatedAt) / 1000);
    lastEvaluatedAt = now;

    const subscriber = controlledSubscriber();
    // A handoff swaps the actor, and with it the arrival envelope: the new
    // one has to warm up from scratch, and the transient in between is not
    // evidence about the path.
    if (subscriber !== lastSubscriber) {
      const isHandoff = lastSubscriber !== undefined;
      lastSubscriber = subscriber;
      if (isHandoff) {
        observedSince = now;
        frozenUntil = now + adaptive.freezeSeconds * 1000;
      }
    }
    if (!subscriber) return;

    // --- failure feedback ---------------------------------------------
    const skips = peek(state.catchUpSkips);
    const underruns = peek(state.audioUnderruns);
    const drops = peek(state.framesDropped);
    // Drops count, but a tenth as hard: a late frame is one dropped
    // picture, while an underrun or a skip is audible or visible as a
    // discontinuity. Without the discount a busy decoder would widen the
    // target for a reason that has nothing to do with the network.
    const events =
      counterDelta(seenSkips, skips) + counterDelta(seenUnderruns, underruns) + counterDelta(seenDrops, drops) * 0.1;
    seenSkips = skips ?? 0;
    seenUnderruns = underruns ?? 0;
    seenDrops = drops ?? 0;

    if (events > 0) {
      widenBias = Math.min(adaptive.widenMax, widenBias + events * adaptive.widenStep);
      frozenUntil = now + adaptive.freezeSeconds * 1000;
    } else {
      widenBias = Math.max(0, widenBias - elapsedSeconds * adaptive.widenDecayPerSecond);
    }

    // --- warm-up gate --------------------------------------------------
    const jitter = subscriber.snapshot.get().context.arrivalJitter;
    const warm =
      jitter !== undefined &&
      jitter.sampleCount >= adaptive.minArrivalSamples &&
      now - observedSince >= adaptive.warmupSeconds * 1000;
    if (!warm) {
      // Nothing trustworthy to say. Before the first publication that means
      // leaving the slot clear, so every reader resolves the consumer →
      // catalog → default chain unchanged. *After* one — a handoff restarts
      // the envelope — it means holding the last proposal instead: dropping
      // back to the fallback would be a setpoint step, and a step is the one
      // thing this controller must never produce.
      if (published === undefined) state.adaptiveTargetLatency.set(undefined);
      return;
    }

    // --- the proposal ---------------------------------------------------
    const spreadSeconds = Math.max(0, jitter.maxOffsetMs - jitter.minOffsetMs) / 1000;
    const catalogJitterSeconds =
      adaptive.useCatalogJitter && subscriber.track.moq.jitter !== undefined ? subscriber.track.moq.jitter / 1000 : 0;
    const proposal = Math.min(
      adaptive.maxTargetLatency,
      Math.max(
        adaptive.minTargetLatency,
        adaptive.floorSeconds + spreadSeconds * adaptive.jitterSafetyFactor + catalogJitterSeconds + widenBias
      )
    );

    // First publication lands whole: there is no setpoint to move away
    // from yet, and the renderers have not anchored against one either.
    if (published === undefined) {
      published = proposal;
      moving = false;
      state.adaptiveTargetLatency.set(published);
      return;
    }

    // --- freeze gates ----------------------------------------------------
    // A non-stable controller is mid-correction toward the current
    // setpoint; moving the setpoint under it is the hunting failure.
    if (now < frozenUntil || peek(state.playoutState) !== 'stable') return;

    // --- Schmitt-triggered, rate-limited approach ------------------------
    const error = proposal - published;
    if (!moving && Math.abs(error) > engageThreshold) moving = true;
    if (moving && Math.abs(error) <= releaseThreshold) moving = false;
    if (!moving || elapsedSeconds === 0) return;

    const rate = error > 0 ? adaptive.maxWidenRatePerSecond : adaptive.maxNarrowRatePerSecond;
    const step = Math.min(Math.abs(error), rate * elapsedSeconds);
    published = published + Math.sign(error) * step;
    state.adaptiveTargetLatency.set(published);
  };

  return createMachineReactor<FsmState>({
    initial: 'inactive',
    monitor: () => derivedStateSignal.get(),
    states: {
      // No timer, no writes: with adaptation off this behavior costs one
      // computed read per subscriber change and nothing else.
      inactive: {},
      adapting: {
        entry: () => {
          reset();
          observedSince = performance.now();
          const timer = setInterval(evaluate, adaptive.intervalMs);
          return () => {
            clearInterval(timer);
            reset();
          };
        },
      },
    },
  });
}

/**
 * Adapt the latency setpoint to observed delivery.
 *
 * @example
 * const reactor = adaptLatencyTarget.setup({ state, context, config });
 */
export const adaptLatencyTarget = defineBehavior({
  stateKeys: [
    'adaptiveLatencyEnabled',
    'adaptiveTargetLatency',
    'playoutState',
    'catchUpSkips',
    'audioUnderruns',
    'framesDropped',
  ],
  contextKeys: ['videoSubscriberActor', 'audioSubscriberActor'],
  setup: setupAdaptLatencyTarget,
});
