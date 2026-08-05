/**
 * **Latency controller: hold playout at the target latency.** Watches the
 * distance from the delivery edge of the track that owns the playout clock
 * — `state.playoutClockOwner`: the audio renderer once it is scheduling,
 * the video renderer before that and for a video-only broadcast — to the
 * position actually being played out (`state.currentTime`) against the
 * target latency and steers playout:
 *
 * - **stable** — latency within band: `playoutRate` 1.
 * - **rate nudge** — latency drifted above/below the band: small rate
 *   adjustment (`playoutRate` 1±`rateNudge`) that the renderers apply to
 *   their clocks; playback speeds up/slows down imperceptibly until
 *   playout re-centers on the target.
 * - **catch-up** — latency blew past `catchUpThreshold` on two consecutive
 *   evaluations (e.g. after a network stall): skip the subscribers straight
 *   to their latest keyframe-led group and reset the rate. A visible jump
 *   beats a permanently-latent stream — but only against a reading that
 *   outlives one evaluation, because a fresh pane's first reading is taken
 *   against a playout position the renderers have not finished placing.
 *
 * **The deadband engages the nudge; only the target releases it.** The
 * band is asymmetric in *time*, not in size: a correction starts when the
 * deviation leaves `deadband` and stops when the deviation is back inside
 * `reclaimBandSeconds` of the target — a small multiple of what one
 * evaluation can move. Releasing at the deadband edge instead, as this
 * did, makes the deadband edge the equilibrium rather than the target,
 * and the difference is not academic: playout latency only ever *grows*
 * between corrections. The audio renderer schedules every buffer no
 * earlier than the context clock (`audio-renderer`'s `startAt`), so each
 * late arrival ratchets the master clock permanently further behind the
 * delivery edge; the video self-clock's own hold-and-drift does the same
 * where there is no audio. Nothing walks either clock back on its own, so
 * a controller that stops at `target + deadband` never returns to target
 * at all — it settles wherever the last excursion left it inside the band
 * and accumulates the next one from there.
 *
 * The **video self-clock already has this property** — it slews onto
 * `edge − target` continuously and stops inside `clockSlewTolerance` of
 * it, not at the controller's deadband. So this is the audio-master case
 * gaining what the video-only case always had, and the two now stop at
 * comparable distances from the same setpoint. Where both run they pull
 * the same direction and compound to at most `clockSlewRate + rateNudge`,
 * the bound `video-renderer` already documents.
 *
 * A correction also releases when the deviation changes *sign* — playout
 * overshot the target — and re-engages only past `deadband` on the far
 * side, so an overshoot cannot leave the previous direction latched.
 *
 * Long corrections are visible to `adaptLatencyTarget`, which freezes
 * while `playoutState` is not `'stable'`. That is the intended reading:
 * a reclaim is the inner loop mid-correction, and a setpoint that moves
 * under it is the hunting failure that behavior's timescale bounds exist
 * to prevent.
 *
 * **Edge-to-playout, not buffer depth.** Measuring newest-buffered minus
 * oldest-buffered would understate real latency by everything held outside
 * the jitter buffer — the video renderer alone keeps `decodeAhead` frames
 * of decoded lookahead — and the controller would then read a shallow
 * buffer as "too little latency" and nudge the rate *down*, raising real
 * latency until enough un-decoded backlog reappeared to satisfy it.
 * `state.currentTime` is the position actually presented, so the distance
 * from the delivery edge to it is the honest number; with no playout
 * position yet there is nothing to control and the controller idles.
 *
 * Owns `state.playoutRate`, `state.measuredLatency`, and
 * `state.playoutState`. The renderers (DOM actors) read `playoutRate`;
 * this behavior stays DOM-free by acting on subscribers only.
 *
 * The target comes from `state.targetLatency` (seconds; consumer input),
 * falling back to the catalog `targetLatency` (milliseconds, msf-01 §5.2.8)
 * **of the same track the depth is measured on**, then
 * `config.defaultTargetLatency`.
 * `state.adaptiveTargetLatency` — written by `adaptLatencyTarget` when
 * adaptation is enabled — slots in *behind* the consumer input and ahead
 * of the catalog (`preferredTargetLatencySeconds`), so an explicit
 * consumer target always wins and an absent adaptive proposal leaves the
 * original chain byte-for-byte intact.
 *
 * Whatever it lands on is republished as `state.effectiveTargetLatency`:
 * the resolved setpoint, resolved against the subscriber actually being
 * controlled, at the moment it was used. Nothing else in the engine can
 * state that number — every other slot is an *input* to the resolution —
 * and without it "did the lower target cost anything" has no baseline.
 *
 * `LatencyControlConfig` spans two layers: this behavior steers playout,
 * and the renderers (`setup-moq-renderers`) anchor and (for video)
 * continuously slew their clocks onto the delivery edge from `joinAtEdge`
 * + the same target. Both read the one config so they cannot aim at
 * different numbers — see `video-renderer`'s `slewTowardEdge` for how the
 * two mechanisms divide the error between them.
 *
 * Evaluation is periodic (`entry` interval) rather than per-frame: the
 * measurement changes ~30-60×/s and reacting to every sample would thrash;
 * the half-second cadence matches the rates being controlled.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import {
  bufferDepthSeconds,
  isUsableTargetSeconds,
  preferredTargetLatencySeconds,
  resolveTargetLatencySeconds,
} from '../../media/moq/timeline';
import type { TrackSubscriberActor } from '../actors/track-subscriber';

export type PlayoutState = 'stable' | 'nudging' | 'catching-up';

/**
 * Which renderer's clock `state.currentTime` is currently coming from.
 *
 * Published by `trackPlayoutTime` (the behavior that samples the clocks)
 * and read here, because "how far is the delivery edge from the position
 * being played out" is only a latency at all when the edge and the position
 * describe the same track — and *which* track the position describes is a
 * fact only the renderers know. Declared beside `PlayoutState` rather than
 * in `setup-moq-renderers` so this DOM-free behavior can read it without
 * importing from a DOM one.
 */
export type PlayoutClockOwner = 'audio' | 'video';

export interface SyncLatencyState {
  /** Consumer-set target latency in seconds. */
  targetLatency?: number;
  /**
   * Adaptive controller's proposed target in seconds, or `undefined` while
   * adaptation is off or still warming up. Ranks below `targetLatency`.
   */
  adaptiveTargetLatency?: number;
  /**
   * The setpoint this controller is actually holding, in seconds, after
   * the whole consumer → adaptive → catalog → default resolution. Output
   * only; the instrument the A/B between fixed and adaptive is read from.
   */
  effectiveTargetLatency?: number;
  /**
   * Catch-up group skips performed since this controller became active.
   * A skip is a visible jump, so its rate is the cost side of any target
   * the adaptive controller proposes.
   */
  catchUpSkips?: number;
  /**
   * Measured playout latency in seconds: newest buffered − the position
   * being presented. This is real edge-to-playout latency, not jitter-
   * buffer depth — it counts everything held past the buffer (decoded
   * lookahead, scheduled audio) that a depth reading misses.
   */
  measuredLatency?: number;
  /** Rate multiplier the renderers apply to their playout clocks. */
  playoutRate?: number;
  playoutState?: PlayoutState;
  /** Playout position in media seconds, published by `trackPlayoutTime`. */
  currentTime?: number;
  /**
   * Which renderer `currentTime` was last sampled from, published by
   * `trackPlayoutTime`. `undefined` before either clock runs.
   */
  playoutClockOwner?: PlayoutClockOwner;
}

export interface SyncLatencyContext {
  videoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
}

export interface SyncLatencyConfig {
  latency?: Partial<LatencyControlConfig>;
}

export interface LatencyControlConfig {
  /**
   * Fallback target latency in seconds — the bottom of the resolution
   * chain, so it is the one layer that has nothing below it to fall
   * through to. An unusable value here is replaced by the built-in
   * default; see `resolveLatencyControlConfig`.
   */
  defaultTargetLatency: number;
  /**
   * Latency deviation (seconds) tolerated before a rate nudge **engages**.
   * It does not also release it — see `reclaimBandSeconds`, and the
   * header for why an equilibrium at the band edge is not one.
   */
  deadband: number;
  /** Rate adjustment magnitude (e.g. 0.05 → 5% faster/slower). */
  rateNudge: number;
  /** Latency (seconds) beyond target that triggers a group skip. */
  catchUpThreshold: number;
  /** Controller evaluation cadence in milliseconds. */
  intervalMs: number;
  /**
   * Place playout at the live edge (newest buffered − target) instead of
   * at the oldest buffered frame, and keep the video self-clock tracking
   * that edge for as long as it self-clocks. Read by the renderers, not by
   * this behavior; see `setup-moq-renderers`.
   */
  joinAtEdge: boolean;
  /**
   * Fraction of real time the video self-clock may spend correcting itself
   * back onto the delivery edge. 0.05 → 50ms/s: below the ~1-frame-per-
   * 20-frames threshold where a speed change reads as one, so the clock
   * can walk off an entire mis-placed join anchor unnoticed. Must stay
   * well below the playout rate or the correction outruns playback and
   * stalls the clock; the renderer clamps what it is handed into
   * `[0, 0.9]` rather than trusting this.
   */
  clockSlewRate: number;
  /**
   * Edge-tracking error (seconds) tolerated before the video self-clock
   * slews. 50ms is above a frame interval at 30fps, so the clock ignores
   * the edge's frame-by-frame quantization instead of chasing it, and well
   * inside `deadband` so the slew has the fine band to itself.
   */
  clockSlewTolerance: number;
}

export const DEFAULT_LATENCY_CONTROL_CONFIG: LatencyControlConfig = {
  defaultTargetLatency: 0.5,
  deadband: 0.25,
  rateNudge: 0.05,
  catchUpThreshold: 3,
  intervalMs: 500,
  joinAtEdge: true,
  clockSlewRate: 0.05,
  clockSlewTolerance: 0.05,
};

/**
 * Merge a host's partial latency config over the defaults, and **complete
 * the target chain's safety guarantee at its one open end.**
 *
 * `resolveTargetLatencySeconds` skips any layer that states a target no
 * clock can hold (`isUsableTargetSeconds`) — consumer input, the adaptive
 * proposal, the catalog. `defaultTargetLatency` is the exception, because
 * it is the bottom of the chain: skipping it would leave nothing to
 * return. So a `{ latency: { defaultTargetLatency: NaN } }` reached the
 * controller and the renderers' join anchor intact, and by the route the
 * chain was hardened to close — one read leaves the video self-clock
 * permanently `NaN` (it writes each slew correction back as its own
 * anchor) and parks the nudge at `1 − rateNudge`, both silently.
 *
 * Sanitized rather than thrown, for the same reason every other layer is:
 * an unusable target is *no statement*, and the layer below a config
 * default is the built-in one. It is also the precedent the neighbouring
 * knob already sets — `video-renderer` clamps `clockSlewRate` into
 * `[0, 0.9]` rather than trusting the config. Values a caller set
 * deliberately as a *relationship* between two knobs still throw; that is
 * `resolveAdaptiveLatencyConfig`'s job, and a single broken number is not
 * that.
 *
 * Every consumer of `LatencyControlConfig` resolves it through here — the
 * controller, both renderer setups, and the pause-hold derivation — so the
 * guarantee holds wherever the config is read rather than wherever someone
 * remembered to check.
 */
export function resolveLatencyControlConfig(latency?: Partial<LatencyControlConfig>): LatencyControlConfig {
  const merged: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...latency };
  if (isUsableTargetSeconds(merged.defaultTargetLatency)) return merged;
  return { ...merged, defaultTargetLatency: DEFAULT_LATENCY_CONTROL_CONFIG.defaultTargetLatency };
}

/**
 * How close to the target an engaged nudge insists on getting before it
 * releases, in seconds.
 *
 * **Derived, not configured.** One evaluation of a nudge moves the
 * measured depth by `rateNudge × intervalMs` — 25ms at the defaults — so a
 * release band narrower than that is a band the loop cannot settle inside:
 * it would step across the target and reverse on the next evaluation,
 * which is audible rate flapping rather than control. Two of those steps
 * is the narrowest band that is reachable *and* still reached from either
 * side, and it lands on 50ms at the defaults — the same distance
 * `clockSlewTolerance` lets the video self-clock stop at, so the two
 * mechanisms give up at comparable error.
 *
 * Capped at `deadband`, which is the degenerate case: a release band as
 * wide as the band that engages the nudge is the old release-at-the-edge
 * behavior, and a tuning that asks for it gets it rather than getting
 * hysteresis inverted.
 */
function reclaimBandSeconds(config: LatencyControlConfig): number {
  return Math.min(config.deadband, 2 * config.rateNudge * (config.intervalMs / 1000));
}

type FsmState = 'inactive' | 'controlling';

/** Direction of an engaged correction: drain (+1), refill (−1), or none. */
type Correction = -1 | 0 | 1;

function setupSyncLatency({
  state,
  context,
  config,
}: {
  state: {
    targetLatency: ReadonlySignal<SyncLatencyState['targetLatency']>;
    adaptiveTargetLatency: ReadonlySignal<SyncLatencyState['adaptiveTargetLatency']>;
    effectiveTargetLatency: Signal<SyncLatencyState['effectiveTargetLatency']>;
    catchUpSkips: Signal<SyncLatencyState['catchUpSkips']>;
    measuredLatency: Signal<SyncLatencyState['measuredLatency']>;
    playoutRate: Signal<SyncLatencyState['playoutRate']>;
    playoutState: Signal<SyncLatencyState['playoutState']>;
    currentTime: ReadonlySignal<SyncLatencyState['currentTime']>;
    playoutClockOwner: ReadonlySignal<SyncLatencyState['playoutClockOwner']>;
  };
  context: {
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
  };
  config?: SyncLatencyConfig;
}): Reactor<FsmState | 'destroying' | 'destroyed'> {
  const controlConfig = resolveLatencyControlConfig(config?.latency);
  const reclaimBand = reclaimBandSeconds(controlConfig);

  /**
   * Whether a correction is engaged, and which way — the whole of this
   * controller's memory, per activation. Reset by `entry` (and by a
   * catch-up skip, which parks the rate at 1 itself). Deliberately *not*
   * reset when the controller idles for want of a playout position: the
   * rate slot is left alone there too, so the correction the renderers are
   * still applying is the correction this variable has to keep describing.
   */
  let correcting: Correction = 0;

  /**
   * Whether the previous evaluation also read past `catchUpThreshold` — the
   * corroboration a group skip needs, since a skip is a visible jump and a
   * join transient reads exactly like a stall for one evaluation. Same
   * per-activation lifetime as `correcting`.
   */
  let catchUpArmed = false;

  const derivedStateSignal = computed<FsmState>(() =>
    context.videoSubscriberActor.get() || context.audioSubscriberActor.get() ? 'controlling' : 'inactive'
  );

  /** Delivery edge of `subscriber`'s buffer to `playoutTimestampUs`. */
  const subscriberLatencySeconds = (
    subscriber: TrackSubscriberActor | undefined,
    playoutTimestampUs: number
  ): number | undefined => {
    const newestTimestampUs = subscriber?.snapshot.get().context.newestTimestampUs;
    if (newestTimestampUs === undefined) return undefined;
    return bufferDepthSeconds(newestTimestampUs, playoutTimestampUs);
  };

  const targetSeconds = (subscriber: TrackSubscriberActor | undefined): number =>
    resolveTargetLatencySeconds(
      preferredTargetLatencySeconds(state.targetLatency.get(), state.adaptiveTargetLatency.get()),
      subscriber?.track.moq.targetLatency,
      controlConfig.defaultTargetLatency
    );

  /** Whether this subscriber has a delivery edge to measure against yet. */
  const hasEdge = (subscriber: TrackSubscriberActor | undefined): boolean =>
    subscriber?.snapshot.get().context.newestTimestampUs !== undefined;

  const evaluate = (): void => {
    const audio = peek(context.audioSubscriberActor);
    const video = peek(context.videoSubscriberActor);
    // **One track supplies both the depth and the setpoint, and it is the
    // track that owns the playout clock.** `bufferDepthSeconds` is `newest
    // buffered − playout`; the subtraction only means "latency" when both
    // ends describe the same track, so the track is chosen by *who owns the
    // clock `currentTime` came from* — `state.playoutClockOwner`, published
    // by `trackPlayoutTime` from the same sample. Anything inferred locally
    // is a guess at another behavior's state: the audio subscriber existing,
    // or even having a delivery edge, does not mean the audio renderer has
    // scheduled anything, and until it has, `currentTime` is still the video
    // renderer's last presented frame.
    //
    // That window is not hypothetical and it is not brief. Measured across
    // 12 fresh pane starts, an audio-first selection opened with readings of
    // 1.5-9.0s that equal `newest audio − oldest presented video` to three
    // decimals — a subtraction across two timebases and across the join
    // backlog — while the audio clock, once it existed, was 0.33-0.41s
    // behind its own edge. A corroboration gate now stops those readings
    // from *skipping* groups, but a skip was only the loudest consequence:
    // the same reading still steers the rate nudge and still publishes as
    // `measuredLatency`, so the join window was steering on a number with
    // no physical meaning. Following the owner makes it mean something.
    //
    // With no owner yet — neither clock has produced a position — nothing is
    // measured anyway (`currentTime` is `undefined` and the controller idles
    // below), and the preference falls back to whichever track has an edge
    // so the setpoint published above is still resolved against a real
    // track.
    //
    // Two tracks of one broadcast need not have coincident delivery edges.
    // A track re-encoded anywhere upstream trails a passed-through one by
    // that pipeline's group of pictures — measured at roughly one GOP, near
    // a second — and charging that delay to the clock owner's depth makes
    // the controller act on latency it cannot drain: it reads a number well
    // under the truth, nudges toward it, and skips groups when the real
    // distance crosses `catchUpThreshold`, pinning the display while
    // reporting a healthy-looking latency.
    //
    // Selecting once is also what keeps the setpoint honest. `targetLatency`
    // is per-track (msf-01 §5.2.8) and nothing requires two tracks to
    // declare the same one, so resolving the target from one track while
    // measuring depth on the other holds a setpoint against a measurement
    // taken somewhere else — and the video renderer's own clock, which
    // resolves the target from the video subscriber, would be slewing toward
    // a third number. The three readers only agree if this one picks a
    // single track for both.
    const owner = peek(state.playoutClockOwner);
    const clockOwnerSubscriber = owner === 'audio' ? audio : owner === 'video' ? video : undefined;
    const subscriber = clockOwnerSubscriber ?? (hasEdge(audio) ? audio : hasEdge(video) ? video : (audio ?? video));
    // Published before the guards below: the resolved setpoint is a fact
    // about the configuration, readable from the moment the controller is
    // active, and the adaptive controller's own hysteresis reads it back.
    const target = targetSeconds(subscriber);
    state.effectiveTargetLatency.set(target);

    // Nothing is being presented yet (pre-roll, or a renderer that has not
    // been handed a surface): there is no playout position to hold, and
    // guessing one from the buffer is what produced the old understatement.
    const currentTime = peek(state.currentTime);
    if (currentTime === undefined) return;
    const playoutTimestampUs = currentTime * 1_000_000;

    // Measured on the subscriber selected above, so the depth and the
    // setpoint cannot come from different tracks.
    //
    // The order this replaced measured video first, on the premise that
    // audio arrives a *group* at a time and is consumed as fast as it lands,
    // leaving its newest sample at the playout position so the depth reads
    // ~0 however much real latency there is. That collapse needs a group
    // long relative to the target, and it was observed against second-long
    // audio groups; at the fraction-of-a-second groups publishers now emit,
    // the clock owner's depth holds steady and well clear of the playout
    // position. A genuinely drained audio buffer still reads as starved, but
    // that is a starved clock — slowing playout to refill is the right
    // response to it, not a reason to measure a different track.
    const depth = subscriberLatencySeconds(subscriber, playoutTimestampUs);
    if (depth === undefined) return;

    state.measuredLatency.set(depth);

    // **A group skip takes two evaluations to justify.** The first reading
    // of a fresh pane is measured against a playout position neither
    // renderer has finished placing: both anchor at `edge − target`, but a
    // relay answers a subscription with a group replay that arrives as a
    // burst, so the edge each one reads is still moving when it anchors, and
    // the video renderer publishes `currentTime` from the oldest replayed
    // frame until the audio schedule takes the clock over. Measured across
    // 12 fresh pane starts on a two-pane stage: the opening reading exceeded
    // the threshold on five of them by 3-9s while the audio clock was in
    // fact 0.33-0.41s behind its own edge — `newest audio − oldest presented
    // video`, a subtraction across two timebases *and* across the backlog,
    // to three decimal places. Each one skipped a healthy pane, and that
    // skip is the visible jump.
    //
    // One evaluation of corroboration separates the two cases exactly,
    // because they differ in duration rather than in magnitude: the join
    // transient is gone by the next evaluation (the renderers' own
    // placement, drop-late and slew have closed it), while a genuinely
    // mis-placed audio schedule or a stalled path still reads over the
    // threshold — audio cannot be fast-forwarded, so nothing else can have
    // repaired it. The cost is that a real stall is skipped one
    // `intervalMs` later, on a stream already `catchUpThreshold` behind.
    //
    // The armed evaluation is not idle: it falls through to the nudge below,
    // which is what a depth that far over target asks for anyway, so the
    // corroborating half-second is spent draining rather than waiting.
    const overThreshold = depth > target + controlConfig.catchUpThreshold;
    if (overThreshold && catchUpArmed) {
      audio?.skipToLatestGroup();
      video?.skipToLatestGroup();
      state.catchUpSkips.set((peek(state.catchUpSkips) ?? 0) + 1);
      // The skip re-places the whole timeline, so whatever was being
      // corrected toward no longer describes anything: park the rate and
      // let the next evaluation decide against the post-skip depth.
      catchUpArmed = false;
      correcting = 0;
      state.playoutRate.set(1);
      state.playoutState.set('catching-up');
      return;
    }
    catchUpArmed = overThreshold;

    const deviation = depth - target;
    // Release before engage, so an overshoot that lands past the deadband on
    // the far side turns around in one evaluation instead of spending one
    // parked at rate 1.
    if (correcting !== 0 && (Math.abs(deviation) <= reclaimBand || Math.sign(deviation) !== correcting)) {
      correcting = 0;
    }
    if (correcting === 0 && Math.abs(deviation) > controlConfig.deadband) {
      correcting = deviation > 0 ? 1 : -1;
    }

    if (correcting === 0) {
      state.playoutRate.set(1);
      state.playoutState.set('stable');
      return;
    }
    // Too deep → play faster to drain; too shallow → slow down to refill.
    // Held until the deviation is back inside `reclaimBand`, which is what
    // makes the target the equilibrium rather than the band edge.
    state.playoutRate.set(correcting > 0 ? 1 + controlConfig.rateNudge : 1 - controlConfig.rateNudge);
    state.playoutState.set('nudging');
  };

  return createMachineReactor<FsmState>({
    initial: 'inactive',
    monitor: () => derivedStateSignal.get(),
    states: {
      inactive: {},
      controlling: {
        entry: () => {
          state.catchUpSkips.set(0);
          correcting = 0;
          catchUpArmed = false;
          const timer = setInterval(evaluate, controlConfig.intervalMs);
          return () => {
            clearInterval(timer);
            state.playoutRate.set(undefined);
            state.playoutState.set(undefined);
            state.measuredLatency.set(undefined);
            state.effectiveTargetLatency.set(undefined);
            state.catchUpSkips.set(undefined);
          };
        },
      },
    },
  });
}

export const syncLatency = defineBehavior({
  stateKeys: [
    'targetLatency',
    'adaptiveTargetLatency',
    'effectiveTargetLatency',
    'catchUpSkips',
    'measuredLatency',
    'playoutRate',
    'playoutState',
    'currentTime',
    'playoutClockOwner',
  ],
  contextKeys: ['videoSubscriberActor', 'audioSubscriberActor'],
  setup: setupSyncLatency,
});
