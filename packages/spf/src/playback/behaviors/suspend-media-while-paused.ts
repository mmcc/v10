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
 * nothing visible. The window derives from `state.targetLatency` (the
 * consumer input `syncLatency` also prefers), falling back to the shared
 * `latency` config; the per-track catalog `targetLatency` is not
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
import { DEFAULT_LATENCY_CONTROL_CONFIG, type LatencyControlConfig } from './sync-latency';

export interface SuspendMediaWhilePausedState {
  /** Adapter-written pause flag; `undefined` means playing. */
  paused?: boolean;
  /** Consumer-set target latency in seconds (shared with `syncLatency`). */
  targetLatency?: number;
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
  stateKeys: ['paused', 'targetLatency', 'mediaSuspended'],
  contextKeys: [],
  setup: ({
    state,
    config,
  }: {
    state: {
      paused: ReadonlySignal<SuspendMediaWhilePausedState['paused']>;
      targetLatency: ReadonlySignal<SuspendMediaWhilePausedState['targetLatency']>;
      mediaSuspended: Signal<SuspendMediaWhilePausedState['mediaSuspended']>;
    };
    config?: SuspendMediaWhilePausedConfig;
  }) => {
    const latencyConfig: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...config?.latency };

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
            const holdSeconds =
              config?.pauseHoldSeconds ??
              (state.targetLatency.get() ?? latencyConfig.defaultTargetLatency) + latencyConfig.catchUpThreshold;
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
