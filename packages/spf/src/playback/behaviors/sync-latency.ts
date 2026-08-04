/**
 * **Latency controller: hold playout at the target latency.** Watches the
 * distance from the delivery edge of the track that owns the playout clock
 * — audio when it exists, video otherwise — to the position actually being
 * played out (`state.currentTime`) against the target latency and steers
 * playout:
 *
 * - **stable** — latency within band: `playoutRate` 1.
 * - **rate nudge** — latency drifted above/below the band: small rate
 *   adjustment (`playoutRate` 1±`rateNudge`) that the renderers apply to
 *   their clocks; playback speeds up/slows down imperceptibly until
 *   playout re-centers on the target.
 * - **catch-up** — latency blew past `catchUpThreshold` (e.g. after a
 *   network stall): skip the subscribers straight to their latest
 *   keyframe-led group and reset the rate. A visible jump beats a
 *   permanently-latent stream.
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
  preferredTargetLatencySeconds,
  resolveTargetLatencySeconds,
} from '../../media/moq/timeline';
import type { TrackSubscriberActor } from '../actors/track-subscriber';

export type PlayoutState = 'stable' | 'nudging' | 'catching-up';

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
}

export interface SyncLatencyContext {
  videoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
}

export interface SyncLatencyConfig {
  latency?: Partial<LatencyControlConfig>;
}

export interface LatencyControlConfig {
  /** Fallback target latency in seconds. */
  defaultTargetLatency: number;
  /** Latency deviation (seconds) tolerated before a rate nudge. */
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

type FsmState = 'inactive' | 'controlling';

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
  };
  context: {
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
  };
  config?: SyncLatencyConfig;
}): Reactor<FsmState | 'destroying' | 'destroyed'> {
  const controlConfig: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...config?.latency };

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
    // ends describe the same track. `state.currentTime` is the audio
    // renderer's clock whenever audio is scheduled and the video renderer's
    // last presented frame otherwise (`trackPlayoutTime`), so measuring
    // audio-first follows that clock instead of racing it, and video is the
    // fallback for a video-only broadcast where its presented frame is both
    // the clock and the only edge there is.
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
    const subscriber = hasEdge(audio) ? audio : hasEdge(video) ? video : (audio ?? video);
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

    if (depth > target + controlConfig.catchUpThreshold) {
      audio?.skipToLatestGroup();
      video?.skipToLatestGroup();
      state.catchUpSkips.set((peek(state.catchUpSkips) ?? 0) + 1);
      state.playoutRate.set(1);
      state.playoutState.set('catching-up');
      return;
    }

    const deviation = depth - target;
    if (Math.abs(deviation) <= controlConfig.deadband) {
      state.playoutRate.set(1);
      state.playoutState.set('stable');
      return;
    }
    // Too deep → play faster to drain; too shallow → slow down to refill.
    state.playoutRate.set(deviation > 0 ? 1 + controlConfig.rateNudge : 1 - controlConfig.rateNudge);
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
  ],
  contextKeys: ['videoSubscriberActor', 'audioSubscriberActor'],
  setup: setupSyncLatency,
});
