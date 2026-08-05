/**
 * **Suspend media delivery when a pause stops being transient.** Owns
 * `state.mediaSuspended`: set once `state.paused` has held continuously
 * for the pause hold window, cleared the moment playback resumes (and on
 * destroy). The subscribe behaviors read it as a gate — suspension
 * releases the media track subscriptions while the session and catalog
 * subscription stay open, so a paused player stops downloading live
 * media it would only discard.
 *
 * ```
 * 'playing' ↔ 'paused'
 * ```
 *
 * The hold window defaults to *target latency + catch-up threshold* — the
 * depth at which `syncLatency` starts discarding the paused buffer via
 * group skips. Shorter pauses (scrubbing, quick toggles) keep the buffer
 * intact and resume from the hold point; anything longer was going to
 * resume at the live edge anyway, so releasing the subscriptions changes
 * nothing visible. The window derives from the same target `syncLatency`
 * is holding — `state.targetLatency`, else `state.adaptiveTargetLatency`
 * — falling back to the shared `latency` config. It reads the adaptive
 * proposal rather than the raw consumer input because the window's whole
 * meaning is "the depth at which the controller starts discarding the
 * paused buffer", and with adaptation running that depth is the adaptive
 * target; sizing it off an input the controller is not using would put
 * the release at the wrong moment in exactly the configuration the knob
 * exists for. The per-track catalog `targetLatency` is still not
 * consulted — the selected track can change mid-pause, and the shared
 * default keeps the window stable. `config.pauseHoldSeconds` overrides
 * the derivation outright.
 *
 * Because the adapter parks `paused: true` before the first `play()`, the
 * hold window also bounds `preload: 'auto'` on a never-played source:
 * media is joined, buffered, and then released until playback actually
 * starts. `undefined` means playing (engine-only drivers never pause by
 * default, matching the renderers' reading of the flag), so drivers that
 * never write `paused` never suspend.
 *
 * Sole writer of `mediaSuspended`. Transition-driven: the timer starts on
 * pause entry, and the entry-returned cleanup (clear timer + clear slot)
 * fires on resume and on destroy alike.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import { preferredTargetLatencySeconds } from '../../media/moq/timeline';
import { type LatencyControlConfig, resolveLatencyControlConfig } from './sync-latency';

export interface SuspendMediaWhilePausedState {
  /** Adapter-written pause flag; `undefined` means playing. */
  paused?: boolean;
  /** Consumer-set target latency in seconds (shared with `syncLatency`). */
  targetLatency?: number;
  /** Adaptive controller's proposal in seconds; ranks below `targetLatency`. */
  adaptiveTargetLatency?: number;
  /** True while a sustained pause has released media delivery. */
  mediaSuspended?: boolean;
}

export interface SuspendMediaWhilePausedConfig {
  /**
   * Continuous pause duration, in seconds, before media delivery
   * suspends. Defaults to target latency + `latency.catchUpThreshold`.
   */
  pauseHoldSeconds?: number;
  /** Latency-controller tuning; shared with `syncLatency`. */
  latency?: Partial<LatencyControlConfig>;
}

/**
 * Mark media delivery suspended after a sustained pause; clear on play.
 *
 * @example
 * const reactor = suspendMediaWhilePaused.setup({ state });
 */
export const suspendMediaWhilePaused = defineBehavior({
  stateKeys: ['paused', 'targetLatency', 'adaptiveTargetLatency', 'mediaSuspended'],
  contextKeys: [],
  setup: ({
    state,
    config,
  }: {
    state: {
      paused: ReadonlySignal<SuspendMediaWhilePausedState['paused']>;
      targetLatency: ReadonlySignal<SuspendMediaWhilePausedState['targetLatency']>;
      adaptiveTargetLatency: ReadonlySignal<SuspendMediaWhilePausedState['adaptiveTargetLatency']>;
      mediaSuspended: Signal<SuspendMediaWhilePausedState['mediaSuspended']>;
    };
    config?: SuspendMediaWhilePausedConfig;
  }) => {
    const latencyConfig: LatencyControlConfig = resolveLatencyControlConfig(config?.latency);

    // setTimeout coerces a non-finite or negative delay to "fire now", so
    // an invalid consumer `targetLatency` or `pauseHoldSeconds` would turn
    // every pause into an immediate suspend. Invalid values fall through
    // to the next step of the derivation instead.
    const isUsableHold = (seconds: number | undefined): seconds is number =>
      seconds !== undefined && Number.isFinite(seconds) && seconds >= 0;

    return createMachineReactor({
      initial: 'playing' as 'playing' | 'paused',
      monitor: () => (state.paused.get() === true ? 'paused' : 'playing'),
      states: {
        playing: {},
        paused: {
          // Cleanup-binds-to-setup: the timer and the suspension are valid
          // for exactly one continuous pause. Entry bodies are untracked,
          // so the target-latency read is pinned at pause time.
          entry: () => {
            // Two independent questions, in order: `isUsableHold` decides
            // whether a stated number can be a delay at all (a `NaN` or
            // negative one would coerce to "fire now" and make every pause
            // an immediate suspend), and `preferredTargetLatencySeconds`
            // decides *which* target stands in for one when nothing states
            // a hold — the adaptive proposal counts wherever no fixed
            // target is set. Each layer that fails either question falls
            // through to the next rather than being honored.
            const configuredHold = config?.pauseHoldSeconds;
            const preferredTarget = preferredTargetLatencySeconds(
              state.targetLatency.get(),
              state.adaptiveTargetLatency.get()
            );
            const holdSeconds = isUsableHold(configuredHold)
              ? configuredHold
              : (isUsableHold(preferredTarget) ? preferredTarget : latencyConfig.defaultTargetLatency) +
                latencyConfig.catchUpThreshold;
            const timer = setTimeout(() => {
              // The resume cleanup clears this timer on the effect flush,
              // but that scheduling is framework-owned — re-check at fire
              // time so a due timer racing the flush can never suspend
              // playback that has already resumed.
              if (peek(state.paused) !== true) return;
              state.mediaSuspended.set(true);
            }, holdSeconds * 1000);
            return () => {
              clearTimeout(timer);
              state.mediaSuspended.set(undefined);
            };
          },
        },
      },
    });
  },
});
