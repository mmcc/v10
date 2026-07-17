/**
 * **Latency controller: hold playout at the target latency.** Watches the
 * jitter-buffer depth of the active subscribers against the target
 * latency and steers playout:
 *
 * - **stable** — depth within band: `playoutRate` 1.
 * - **rate nudge** — depth drifted above/below the band: small rate
 *   adjustment (`playoutRate` 1±`rateNudge`) that the renderers apply to
 *   their clocks; playback speeds up/slows down imperceptibly until the
 *   buffer re-centers.
 * - **catch-up** — depth blew past `catchUpThreshold` (e.g. after a
 *   network stall): skip the subscribers straight to their latest
 *   keyframe-led group and reset the rate. A visible jump beats a
 *   permanently-latent stream.
 *
 * Owns `state.playoutRate`, `state.measuredLatency`, and
 * `state.playoutState`. The renderers (DOM actors) read `playoutRate`;
 * this behavior stays DOM-free by acting on subscribers only.
 *
 * The target comes from `state.targetLatency` (seconds; consumer input),
 * falling back to the selected track's catalog `targetLatency`
 * (milliseconds, msf-01 §5.2.8), then `config.defaultTargetLatency`.
 *
 * Evaluation is periodic (`entry` interval) rather than per-frame: depth
 * changes ~30-60×/s and reacting to every sample would thrash; the
 * half-second cadence matches the rates being controlled.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import { bufferDepthSeconds } from '../../media/moq/timeline';
import type { TrackSubscriberActor } from '../actors/track-subscriber';

export type PlayoutState = 'stable' | 'nudging' | 'catching-up';

export interface SyncLatencyState {
  /** Consumer-set target latency in seconds. */
  targetLatency?: number;
  /** Measured buffer depth (newest buffered − oldest buffered) in seconds. */
  measuredLatency?: number;
  /** Rate multiplier the renderers apply to their playout clocks. */
  playoutRate?: number;
  playoutState?: PlayoutState;
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
  /** Depth deviation (seconds) tolerated before a rate nudge. */
  deadband: number;
  /** Rate adjustment magnitude (e.g. 0.05 → 5% faster/slower). */
  rateNudge: number;
  /** Depth (seconds) beyond target that triggers a group skip. */
  catchUpThreshold: number;
  /** Controller evaluation cadence in milliseconds. */
  intervalMs: number;
}

export const DEFAULT_LATENCY_CONTROL_CONFIG: LatencyControlConfig = {
  defaultTargetLatency: 0.5,
  deadband: 0.25,
  rateNudge: 0.05,
  catchUpThreshold: 3,
  intervalMs: 500,
};

type FsmState = 'inactive' | 'controlling';

function setupSyncLatency({
  state,
  context,
  config,
}: {
  state: {
    targetLatency: ReadonlySignal<SyncLatencyState['targetLatency']>;
    measuredLatency: Signal<SyncLatencyState['measuredLatency']>;
    playoutRate: Signal<SyncLatencyState['playoutRate']>;
    playoutState: Signal<SyncLatencyState['playoutState']>;
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

  const subscriberDepthSeconds = (subscriber: TrackSubscriberActor | undefined): number | undefined => {
    const buffer = subscriber?.snapshot.get().context;
    if (!buffer || buffer.newestTimestampUs === undefined || buffer.oldestTimestampUs === undefined) return undefined;
    return bufferDepthSeconds(buffer.newestTimestampUs, buffer.oldestTimestampUs);
  };

  const targetSeconds = (subscriber: TrackSubscriberActor | undefined): number => {
    const stateTarget = state.targetLatency.get();
    if (stateTarget !== undefined) return stateTarget;
    const catalogTargetMs = subscriber?.track.moq.targetLatency;
    if (catalogTargetMs !== undefined) return catalogTargetMs / 1000;
    return controlConfig.defaultTargetLatency;
  };

  const evaluate = (): void => {
    // The audio buffer is the master-clock side; prefer it as the
    // controlled quantity and fall back to video for video-only playback.
    const audio = peek(context.audioSubscriberActor);
    const video = peek(context.videoSubscriberActor);
    const subscriber = audio ?? video;
    const depth = subscriberDepthSeconds(audio) ?? subscriberDepthSeconds(video);
    if (depth === undefined) return;

    const target = targetSeconds(subscriber);
    state.measuredLatency.set(depth);

    if (depth > target + controlConfig.catchUpThreshold) {
      audio?.skipToLatestGroup();
      video?.skipToLatestGroup();
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
          const timer = setInterval(evaluate, controlConfig.intervalMs);
          return () => {
            clearInterval(timer);
            state.playoutRate.set(undefined);
            state.playoutState.set(undefined);
            state.measuredLatency.set(undefined);
          };
        },
      },
    },
  });
}

export const syncLatency = defineBehavior({
  stateKeys: ['targetLatency', 'measuredLatency', 'playoutRate', 'playoutState'],
  contextKeys: ['videoSubscriberActor', 'audioSubscriberActor'],
  setup: setupSyncLatency,
});
