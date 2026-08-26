/**
 * **Propose the lowest target latency the observed path can sustain.** Owns `state.adaptiveTargetLatency` (seconds),
 * which `syncLatency` and the renderers rank _below_ an explicit `state.targetLatency` and _above_ the catalog target —
 * so this behavior can only ever fill in where the consumer stated nothing, and publishing `undefined` restores the
 * original chain exactly.
 *
 * Off by default. With `adaptiveLatency.enabled` unset (and no `state.adaptiveLatencyEnabled` override) the reactor
 * stays `inactive`: no timer, no slot writes, and every reader resolves the same target it resolved before this
 * behavior existed. That is the control arm of the A/B this exists to make measurable.
 *
 * ## What it can observe, and what it cannot
 *
 * There is no transport RTT here. spf speaks its own draft-19 stack (no PROBE — that is a moq-lite extension) and
 * browsers do not populate `WebTransport.getStats().smoothedRtt`, so the absolute one-way delay is simply not
 * available. The no-RTT path is therefore the only path, and the estimate is built from what _is_ observable:
 *
 * - **Arrival jitter** (`TrackSubscriberContext.arrivalJitter`): the decaying spread between the earliest and latest
 *   recent arrival offsets. Offsets mix two unrelated clock epochs so their absolute value means nothing; their
 *   _spread_ is exactly the delivery variance a jitter buffer exists to absorb, and it is the one thing a receiver can
 *   measure without a synchronised clock.
 * - **The publisher's declared `jitter`** (msf-01 §5.2.9, milliseconds): packaging/encode variance the observation window
 *   may not have covered yet. Additive, and only when the catalog states one.
 * - **A starting cushion** (`floorSeconds`): decode, compositing, and the controller's own sampling granularity. It is a
 *   **constant, not a derivation** — hang's precedent is the same shape (a flat 100ms fallback) and pretending
 *   otherwise would be the dishonest part.
 * - **Failure feedback**: audio underruns, catch-up skips, and late-frame drops. These are the only _direct_ evidence
 *   that a target is below what the path sustains, which is why the plumbing to surface them (`trackPlayoutHealth`,
 *   `AudioRendererContext.underruns`, `syncLatency`'s `catchUpSkips`) was worth adding.
 *
 * ## Widen fast, narrow slow
 *
 * `widenBias` is an integrator over failure events, and it is the mirror image of the dual-EWMA bandwidth idiom
 * (`bandwidth-estimator`: take `min(fast, slow)` so estimates fall quickly and rise slowly). Here the asymmetry runs
 * the other way — an underrun is a picture that froze, and the cost of over-buffering is latency nobody dies of — so
 * the bias jumps on every event and bleeds off linearly over tens of seconds.
 *
 * ## Separation of timescales — the constraint that shapes everything
 *
 * Three negative-feedback loops act on one variable, and adaptation adds the third by making the _setpoint_ move:
 *
 * 1. `syncLatency`'s ±`rateNudge` bang-bang, every `latency.intervalMs`.
 * 2. The video self-clock's continuous slew onto the delivery edge, at `latency.clockSlewRate` of real time — **only**
 *    when there is no audio master clock.
 * 3. This behavior's moving setpoint.
 *
 * Both (1) and (2) are corrections toward the target, so a target that moves faster than they can follow is a target
 * they never reach. Two bounds keep that from happening and both are **validated, not merely documented**
 * (`resolveAdaptiveLatencyConfig` throws):
 *
 * - `maxWidenRatePerSecond < latency.clockSlewRate / 2`. The renderers consult the edge target on every clock read, so
 *   the slew goal moves with the setpoint; at half the slew budget the clock still closes on it. Concretely: 50ms of
 *   target movement spread over 2s is 0.025, half of the 0.05 default budget — fine. The same 50ms over 500ms is 0.1,
 *   double the budget, and never settles.
 * - `intervalMs >= 4 × latency.intervalMs`. The inner loop needs several evaluations against a stationary setpoint before
 *   the outer loop moves it, or the two alias into one badly-damped loop.
 *
 * **With audio present the slew is off** and audio's join anchor only applies at join or discontinuity, so a
 * mid-playback setpoint change is realized _entirely_ through the bang-bang nudge — the documented "latency controller
 * hunting" failure mode. That is why widening is not a step even though the evidence for it is acute: there is no
 * mechanism at either the clock or the nudge that can realize a step without hunting, so "prompt" here means _begins at
 * the very next evaluation and moves monotonically_, not _jumps_. The bias itself rises instantly; only its journey
 * into the published setpoint is rate-limited, and the acute case is meanwhile handled by the nudge, already refilling
 * at 5%.
 *
 * The two directions are deliberately asymmetric, and not only in rate:
 *
 * - **Widening** needs a stable inner loop and nothing else. It runs at `maxWidenRatePerSecond`.
 * - **Narrowing** additionally waits out `quietSeconds` since the last failure event or subscriber handoff, and runs at
 *   `maxNarrowRatePerSecond` — a quarter of the widen rate. `widenBias` decays through the same gate, because relaxing
 *   the safety margin is narrowing one step removed.
 *
 * Both sit behind a Schmitt trigger sized off the finest band any inner loop acts on, so the setpoint moves in
 * occasional deliberate runs rather than creeping continuously — a creeping setpoint is one the nudge can never
 * converge on.
 *
 * Adaptation stops entirely while `playoutState` is not `'stable'`: the inner loop is mid-correction, and that is the
 * moment a moving setpoint turns into hunting.
 *
 * ## Warm-up
 *
 * Before `minArrivalSamples` arrivals _and_ `warmupSeconds` of observation the slot stays `undefined` and every reader
 * falls through to the existing consumer → catalog → default chain. Same discipline as `hasGoodEstimate` in the
 * bandwidth estimator: publishing a target computed from three frames is worse than publishing none.
 *
 * Both halves re-arm together whenever the observation epoch restarts — a subscriber handoff, or the subscriber
 * dropping its own arrival baseline across an auth-expiry resubscribe. Re-arming only the sample count would leave the
 * window counting from an epoch that had ended.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import type { TrackSubscriberActor } from '../actors/track-subscriber';
import { type LatencyControlConfig, type PlayoutState, resolveLatencyControlConfig } from './sync-latency';

// =============================================================================
// State / context / config
// =============================================================================

export interface AdaptLatencyTargetState {
  /**
   * Runtime override of `config.adaptiveLatency.enabled`, written by a consumer (the element's `adaptive-latency`
   * attribute). `undefined` defers to config — the same shape `targetLatency` has against `defaultTargetLatency`.
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
  /** Master switch. **False by default** — adaptation is opt-in until the A/B against the fixed setpoint says otherwise. */
  enabled: boolean;
  /**
   * Evaluation cadence in milliseconds. An explicit value must be at least 4× `latency.intervalMs` so the inner control
   * loop settles between moves; the default is raised to satisfy that automatically.
   */
  intervalMs: number;
  /** Hard floor on the proposed target, in seconds. */
  minTargetLatency: number;
  /** Hard ceiling on the proposed target, in seconds. */
  maxTargetLatency: number;
  /**
   * Constant cushion added to every proposal, in seconds: decode, compositing, and this controller's own sampling
   * granularity. Not derived from anything — hang carries the same shape as a flat 100ms fallback, and that is the
   * honest description of this number too.
   */
  floorSeconds: number;
  /**
   * Multiplier on the observed arrival spread. Above 1 because the window has seen a sample of the delay distribution,
   * not its tail.
   */
  jitterSafetyFactor: number;
  /** Add the catalog's declared `jitter` (msf-01 §5.2.9) to the margin. */
  useCatalogJitter: boolean;
  /**
   * Late-frame drops that add up to one failure event — a positive whole number of frames, validated. Underruns and
   * catch-up skips each count as one on their own; drops need bulk.
   */
  dropsPerEvent: number;
  /** Seconds added to `widenBias` per failure event. */
  widenStep: number;
  /** Ceiling on `widenBias`, in seconds. */
  widenMax: number;
  /** Seconds of `widenBias` shed per second of quiet, stable playback. */
  widenDecayPerSecond: number;
  /**
   * Maximum rate the published target may _increase_, as seconds of target per second of real time. An explicit value
   * is validated against half the slower of `latency.clockSlewRate` and `latency.rateNudge`; the default is lowered to
   * satisfy it.
   */
  maxWidenRatePerSecond: number;
  /** Maximum rate the published target may _decrease_. */
  maxNarrowRatePerSecond: number;
  /** Arrivals required on the controlled track before publishing anything. */
  minArrivalSamples: number;
  /** Seconds of observation required before publishing anything. */
  warmupSeconds: number;
  /**
   * Seconds of quiet required after a failure event or a subscriber handoff before the target may _narrow_ again (and
   * before `widenBias` resumes decaying). Widening is not gated by it.
   */
  quietSeconds: number;
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
  // A third of a second of dropped video at 30fps.
  dropsPerEvent: 10,
  // One event ≈ one GOP of extra cushion. Sized to be felt, since the
  // rate limit below spreads it over several seconds anyway.
  widenStep: 0.15,
  widenMax: 1,
  // From `widenMax` back to zero in ~100s of clean playback, and one
  // `widenStep` in 15s: long enough that a flaky minute does not
  // evaporate between spikes, and an order of magnitude slower than the
  // step that put it there.
  widenDecayPerSecond: 0.01,
  // Strictly below DEFAULT_LATENCY_CONTROL_CONFIG.clockSlewRate / 2 = 0.025.
  maxWidenRatePerSecond: 0.02,
  maxNarrowRatePerSecond: 0.005,
  // ~2s of 30fps video, or ~1.3s of 48kHz AAC.
  minArrivalSamples: 60,
  warmupSeconds: 3,
  quietSeconds: 5,
};

export interface AdaptLatencyTargetConfig {
  /** Shared with `syncLatency` and the renderers — read for its timescale bounds. */
  latency?: Partial<LatencyControlConfig>;
  adaptiveLatency?: Partial<AdaptiveLatencyConfig>;
}

/**
 * How much of real time the inner loops can spend correcting toward the setpoint — the budget the setpoint's own
 * movement has to stay inside.
 *
 * Which loop binds depends on the configuration: the video self-clock slews at `clockSlewRate`, but only while it _has_
 * an edge target (`joinAtEdge`), and the bang-bang nudge corrects at `rateNudge` always. The slower of the applicable
 * two is what a moving setpoint has to let catch up.
 */
function correctionBudgetPerSecond(latency: LatencyControlConfig): number {
  const slewApplies = latency.joinAtEdge && latency.clockSlewRate > 0;

  return (slewApplies ? Math.min(latency.clockSlewRate, latency.rateNudge) : latency.rateNudge) / 2;
}

/**
 * Merge the adaptive defaults against a given latency configuration and **enforce the separation-of-timescales
 * invariants**.
 *
 * Two halves, and the split is what keeps the enforcement from being a nuisance:
 *
 * - The **defaults derive from `latency`**, so an untouched adaptive config satisfies the invariants for _any_ latency
 *   tuning — including one that parks the controller. A default that could throw would make this behavior's mere
 *   presence in the composition a hazard for engines that never enable it.
 * - An **explicitly supplied** value is validated and throws. It encodes a relationship between two knobs a caller set
 *   deliberately, and silently rewriting one produces a player whose latency wanders for reasons nothing reports — a
 *   control loop that never settles is precisely the class of bug that cannot be attributed after the fact.
 *
 * Exported so a host can validate a candidate configuration without standing up an engine.
 */
export function resolveAdaptiveLatencyConfig(config?: AdaptLatencyTargetConfig): {
  adaptive: AdaptiveLatencyConfig;
  latency: LatencyControlConfig;
} {
  const latency: LatencyControlConfig = resolveLatencyControlConfig(config?.latency);
  const supplied = config?.adaptiveLatency ?? {};
  const budget = correctionBudgetPerSecond(latency);

  const adaptive: AdaptiveLatencyConfig = {
    ...DEFAULT_ADAPTIVE_LATENCY_CONFIG,
    intervalMs: Math.max(DEFAULT_ADAPTIVE_LATENCY_CONFIG.intervalMs, latency.intervalMs * 4),
    maxWidenRatePerSecond: Math.min(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxWidenRatePerSecond, budget * 0.8),
    maxNarrowRatePerSecond: Math.min(DEFAULT_ADAPTIVE_LATENCY_CONFIG.maxNarrowRatePerSecond, budget * 0.2),
    ...supplied,
  };

  // Sign and finiteness first: the budget checks below are *upper* bounds,
  // and every broken value passes them comfortably. The approach step is
  // `Math.sign(error) × rate × elapsed`, so a negative rate walks the
  // published setpoint *away* from the proposal it was computed to reach,
  // and `NaN` publishes `NaN` — which every renderer clock then reads as
  // its slew target. Both look exactly like a very cautious controller.
  for (const name of ['maxWidenRatePerSecond', 'maxNarrowRatePerSecond'] as const) {
    const rate = supplied[name];

    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) {
      throw new RangeError(
        `adaptiveLatency.${name} (${rate}) must be a finite, non-negative number of seconds of target per second ` +
          'of real time. The approach step is signed by the error, not by the rate, so a negative one moves the ' +
          'setpoint opposite to the proposal and a non-finite one publishes NaN as the setpoint.'
      );
    }
  }

  // Zero would make `Math.floor(delta / dropsPerEvent)` Infinity on the
  // first dropped frame, slamming `widenBias` to its ceiling and holding
  // the target there; a negative divisor inverts the feedback, so drops
  // subtract events instead of adding them.
  //
  // A *fractional* one divides up rather than down, which is the same
  // failure arriving quietly: `Math.floor(1 / 0.5)` is two failure events
  // out of one dropped frame, and 0.1 is ten of them. Measured against the
  // defaults, one late frame peaked the published target at 0.28s with a
  // budget of 1, 0.40s at 0.5 and 0.84s at 0.1 — where the default budget
  // of 10 reads one drop as what it is, no evidence at all. So the count
  // is a count: this divisor exists to say "only in bulk", and any value
  // below 1 says the opposite.
  if (
    supplied.dropsPerEvent !== undefined &&
    (!Number.isInteger(supplied.dropsPerEvent) || supplied.dropsPerEvent <= 0)
  ) {
    throw new RangeError(
      `adaptiveLatency.dropsPerEvent (${supplied.dropsPerEvent}) must be a positive whole number of frames: it ` +
        'divides the late-frame drop delta into failure events, so zero makes one dropped frame an unbounded number ' +
        'of them, a negative value inverts the feedback, and a fraction amplifies one drop into several.'
    );
  }

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
 * Increase in a monotonic counter since `previous`. A counter that went away (`undefined`) or restarted lower is a
 * fresh owner — the controller re-baselines rather than counting the discontinuity as events.
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

  // Schmitt-trigger bounds: the setpoint does not start moving until the
  // proposal is at least `engageThreshold` away, and stops once inside
  // `releaseThreshold`. Sized off the *finest* band any inner loop acts
  // on — the self-clock's slew tolerance, or half the controller's
  // deadband where that is tighter. A setpoint move smaller than that is
  // invisible to every loop below and buys only churn; without the band
  // the setpoint would creep continuously and the nudge would never have
  // a stationary thing to converge on.
  const engageThreshold = Math.min(latency.clockSlewTolerance, latency.deadband / 2);
  const releaseThreshold = engageThreshold / 2;

  /** Per-activation controller state; reset by `entry`. */
  let widenBias = 0;
  let published: number | undefined;
  let moving = false;
  let observedSince = 0;
  let quietUntil = 0;
  let lastSubscriber: TrackSubscriberActor | undefined;
  let lastEvaluatedAt = 0;
  let seenSkips = 0;
  let seenUnderruns = 0;
  let seenDrops = 0;
  /**
   * Envelope epoch the controlled subscriber last reported, so a restart of its arrival measurements can be recognised
   * as a new observation epoch on the same actor — see `evaluate`. `undefined` before any envelope has been read, and
   * reset to it whenever the subscriber changes, because the count is the subscriber's own and means nothing across a
   * swap.
   */
  let seenArrivalEpoch: number | undefined;
  /**
   * Late-frame drops counted but not yet worth a failure event.
   *
   * `dropsPerEvent` is a threshold on the _total_, not on one evaluation's delta. Taking the quotient of each window's
   * delta and discarding the remainder makes any drop rate below `dropsPerEvent` per window invisible forever: at the
   * defaults, four drops every two seconds is two frames a second of visibly broken video that the controller reads as
   * a clean path. Carried across evaluations, the accounting becomes the cumulative quotient the threshold was meant to
   * express.
   */
  let dropCarry = 0;

  const reset = (): void => {
    widenBias = 0;
    published = undefined;
    moving = false;
    observedSince = 0;
    quietUntil = 0;
    lastSubscriber = undefined;
    lastEvaluatedAt = 0;
    seenSkips = 0;
    seenUnderruns = 0;
    seenDrops = 0;
    seenArrivalEpoch = undefined;
    dropCarry = 0;
    state.adaptiveTargetLatency.set(undefined);
  };

  /**
   * Start a fresh observation epoch: nothing measured before `now` is evidence about the delivery the controller is
   * watching from here.
   *
   * Both halves move together, because a fresh epoch is exactly as suspect as a failure — `warmupSeconds` before
   * anything is published at all, and `quietSeconds` before the target may narrow again.
   */
  const beginObservationEpoch = (now: number): void => {
    observedSince = now;
    quietUntil = now + adaptive.quietSeconds * 1000;
  };

  /**
   * The track whose delivery the controller reasons about: audio when there is any, because it owns the master clock in
   * steady state and starves audibly.
   *
   * **Deliberately not the clock-owner selection `syncLatency` makes**, and the asymmetry is worth stating because the
   * two look like they should match. They answer different questions. That controller subtracts a position from an
   * edge, so it must have both ends on one track or the number is not a latency at all. This one asks how much delivery
   * variance a jitter buffer has to absorb — a property of the _path_, which both tracks of a broadcast share, sampled
   * on whichever of them will make a shortfall obvious first.
   *
   * Following the clock owner here would restart the observation epoch on every handover — the join, an autoplay
   * unlock, a sustained pause releasing — and each restart costs `warmupSeconds` before this behavior may say anything
   * at all. At a normal start that is two restarts (video takes the clock, then audio does), so the first proposal
   * would arrive seconds later on every playback, to align a selection whose only consequence is which of two tracks on
   * one path supplied the spread.
   *
   * What must not happen — a proposal derived from a track that has no arrivals to describe, while the other one is the
   * whole reason the controller is running — is already impossible: the warm-up gate is evaluated on _this_
   * subscriber's envelope, so an edgeless one publishes nothing rather than something arbitrary.
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
      seenArrivalEpoch = undefined;

      if (isHandoff) beginObservationEpoch(now);
    }

    if (!subscriber) return;

    // --- failure feedback ---------------------------------------------
    const skips = peek(state.catchUpSkips);
    const underruns = peek(state.audioUnderruns);
    const drops = peek(state.framesDropped);

    // A counter that went away or restarted lower is a fresh owner
    // (`counterDelta` re-baselines rather than counting the
    // discontinuity), and a sub-threshold carry from the previous owner is
    // not evidence about this one.
    if (drops === undefined || drops < seenDrops) dropCarry = 0;

    // An underrun or a skip is one event each — both are audible or
    // visible discontinuities. Late-frame drops only count in bulk: a
    // handful per window is a busy decoder rather than a starved path,
    // and treating each one as evidence would keep the target permanently
    // widened on a loaded machine for a reason the network never caused.
    // "In bulk" is a threshold on the running total though, so the
    // remainder below it is carried rather than discarded — see
    // `dropCarry`.
    dropCarry += counterDelta(seenDrops, drops);
    const dropEvents = Math.floor(dropCarry / adaptive.dropsPerEvent);

    dropCarry -= dropEvents * adaptive.dropsPerEvent;
    const events = counterDelta(seenSkips, skips) + counterDelta(seenUnderruns, underruns) + dropEvents;

    seenSkips = skips ?? 0;
    seenUnderruns = underruns ?? 0;
    seenDrops = drops ?? 0;

    const stable = peek(state.playoutState) === 'stable';

    if (events > 0) {
      widenBias = Math.min(adaptive.widenMax, widenBias + events * adaptive.widenStep);
      quietUntil = now + adaptive.quietSeconds * 1000;
    }

    const quiet = now >= quietUntil;

    // The bias only bleeds off through the same gate narrowing does:
    // relaxing the safety margin *is* narrowing, one step removed.
    if (events === 0 && quiet && stable) {
      widenBias = Math.max(0, widenBias - elapsedSeconds * adaptive.widenDecayPerSecond);
    }

    // --- warm-up gate --------------------------------------------------
    const jitter = subscriber.snapshot.get().context.arrivalJitter;

    // **An envelope can restart without the actor changing.** The auth-expiry
    // resubscribe drops the subscriber's arrival baseline
    // (`resetArrivalBaseline`), which is a new measurement epoch on the very
    // object the controller is already watching, and only the *sample count*
    // half of the gate below re-arms by itself. The observation window would
    // go on counting from an epoch that had ended, so a burst of
    // `minArrivalSamples` post-reconnect frames satisfies both halves with
    // well under `warmupSeconds` of new observation behind them — and the
    // moment just after a path failure is precisely when its envelope reads
    // narrowest, so the proposal it produces is the lowest target at the
    // worst time to propose one.
    //
    // The restart is read from `epoch`, which the envelope publishes for this,
    // rather than inferred from a count that fell. **The inference is lossy at
    // exactly these cadences**, because this loop samples the envelope on its
    // own `intervalMs` and not per frame: a count that restarts at zero and
    // climbs back past its last-read value inside one window never appears to
    // have gone backwards. The gate wants `minArrivalSamples` = ~1.3s of
    // 48kHz audio, so any restart with under two full windows of counting
    // behind it — the join, a resubscribe during a slow start — is overtaken
    // and missed, and missing it publishes the narrow post-reconnect envelope
    // whole, there being no earlier proposal to hold. An epoch cannot be
    // overtaken.
    if (jitter !== undefined && seenArrivalEpoch !== undefined && jitter.epoch !== seenArrivalEpoch) {
      beginObservationEpoch(now);
    }

    if (jitter !== undefined) seenArrivalEpoch = jitter.epoch;

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

    // --- directional gates ------------------------------------------------
    // A non-stable controller is mid-correction toward the current
    // setpoint; moving the setpoint under it is the hunting failure, in
    // either direction.
    if (!stable) return;

    const error = proposal - published;
    // Narrowing additionally waits out the quiet window. Widening does
    // not: an underrun or a skip is a definite failure rather than a
    // suspect measurement, so the response begins at the very next
    // evaluation — it is still rate-limited, because neither the slew nor
    // the nudge can realize a step without hunting, but it never waits.
    if (error < 0 && !quiet) return;

    // --- Schmitt-triggered, rate-limited approach ------------------------
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
          // Baseline the failure counters at activation. They are
          // cumulative and the latency controller has usually been
          // running for a while, so counting from zero would open with a
          // burst of events that already happened.
          seenSkips = state.catchUpSkips.get() ?? 0;
          seenUnderruns = state.audioUnderruns.get() ?? 0;
          seenDrops = state.framesDropped.get() ?? 0;
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
 *   const reactor = adaptLatencyTarget.setup({ state, context, config });
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
