/**
 * **Wire subscriber jitter buffers into the WebCodecs renderers.** Two
 * behaviors, one per leg:
 *
 * - `setupAudioRenderer` — owns `context.audioRendererActor` (created when
 *   `context.audioContext` appears) and points it at the active audio
 *   subscriber. The audio renderer owns the **master clock**, so this
 *   behavior also owns `state.currentTime`: a playout-cadence interval
 *   publishes the clock as seconds (the MoQ engine has no HTMLMediaElement
 *   to read time from). With no audio scheduled it falls back to the video
 *   renderer's last presented timestamp, so a video-only catalog still
 *   reports progress.
 * - `setupVideoRenderer` — owns `context.videoRendererActor` (created when
 *   `context.renderSurface` appears), points it at the active video
 *   subscriber, and slaves its presentation to the audio renderer's clock
 *   when one exists (falling back to the renderer's self-clock for
 *   video-only playback).
 *
 * Both apply `state.playoutRate` (latency-controller nudges) through the
 * renderer's `getPlaybackRate` seam — gated to 0 while `state.paused` is
 * set, so video-only playback actually freezes on pause — and both
 * re-point on subscriber-actor swaps — which is the moment a
 * make-before-break handoff completes; the renderer's keyframe gate
 * handles the decoder reconfiguration.
 *
 * Both also own the **playout anchor**: with `latency.joinAtEdge` set they
 * hand each renderer the live edge of its own jitter buffer (newest
 * buffered − target latency) as the point playout should start from, at
 * join and after every catch-up skip. The controller in `sync-latency`
 * steers latency once playout is running; the anchor is what decides
 * where "running" begins, which is why it lives here — the renderers own
 * the clocks — rather than in the controller.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import { toAudioDecoderConfig, toVideoDecoderConfig } from '../../../media/moq/codec-mapping';
import type { MoqAudioTrack, MoqVideoTrack } from '../../../media/moq/parse-catalog';
import { joinAnchorUs, resolveTargetLatencySeconds } from '../../../media/moq/timeline';
import {
  type AudioContextLike,
  type AudioRendererActor,
  createAudioRendererActor,
} from '../../actors/dom/audio-renderer';
import { createVideoRendererActor, type VideoRendererActor } from '../../actors/dom/video-renderer';
import type { TrackSubscriberActor } from '../../actors/track-subscriber';
import { DEFAULT_LATENCY_CONTROL_CONFIG, type LatencyControlConfig } from '../sync-latency';

// =============================================================================
// Shared state/context shapes
// =============================================================================

export interface MoqRendererState {
  playoutRate?: number;
  /** Consumer-set target latency in seconds; the anchor's distance from the live edge. */
  targetLatency?: number;
  /**
   * Adapter-written pause flag; `undefined` means playing. Gates the
   * renderers' playout rate to 0 — the video self-clock re-anchors on rate
   * changes, so rate 0 holds presentation exactly and resumes from the
   * hold point (there is no audio master clock to freeze in video-only
   * playback).
   */
  paused?: boolean;
  currentTime?: number;
}

export interface MoqRendererContext {
  renderSurface?: HTMLCanvasElement | OffscreenCanvas;
  audioContext?: AudioContextLike;
  videoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
  videoRendererActor?: VideoRendererActor;
  audioRendererActor?: AudioRendererActor;
}

const CLOCK_PUBLISH_INTERVAL_MS = 100;

export interface MoqRendererConfig {
  /** Shared with `syncLatency`: `joinAtEdge` + the target the anchor is placed against. */
  latency?: Partial<LatencyControlConfig>;
}

/**
 * The live edge of `subscriberSignal`'s jitter buffer, `targetLatency`
 * back: where playout should anchor. `undefined` disables edge anchoring —
 * the knob is off, there is no subscriber, or nothing has arrived yet.
 */
function makeJoinAnchor(
  subscriberSignal: ReadonlySignal<TrackSubscriberActor | undefined>,
  targetLatencySignal: ReadonlySignal<number | undefined>,
  latency: LatencyControlConfig
): (() => number | undefined) | undefined {
  if (!latency.joinAtEdge) return undefined;
  return () => {
    const subscriber = peek(subscriberSignal);
    const newestTimestampUs = subscriber?.snapshot.get().context.newestTimestampUs;
    if (newestTimestampUs === undefined) return undefined;
    const targetSeconds = resolveTargetLatencySeconds(
      peek(targetLatencySignal),
      subscriber?.track.moq.targetLatency,
      latency.defaultTargetLatency
    );
    return joinAnchorUs(newestTimestampUs, targetSeconds);
  };
}

// =============================================================================
// Audio
// =============================================================================

function setupAudioRendererSetup({
  state,
  context,
  config,
}: {
  state: {
    playoutRate: ReadonlySignal<number | undefined>;
    targetLatency: ReadonlySignal<number | undefined>;
    currentTime: Signal<number | undefined>;
  };
  context: {
    audioContext: ReadonlySignal<AudioContextLike | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioRendererActor: Signal<AudioRendererActor | undefined>;
    /** Read-only, for the video-only clock fallback below. */
    videoRendererActor: ReadonlySignal<VideoRendererActor | undefined>;
  };
  config?: MoqRendererConfig;
}): Reactor<'preconditions-unmet' | 'renderer-active' | 'destroying' | 'destroyed'> {
  const latencyConfig: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...config?.latency };
  const derivedStateSignal = computed(() =>
    context.audioContext.get() ? ('renderer-active' as const) : ('preconditions-unmet' as const)
  );

  return createMachineReactor<'preconditions-unmet' | 'renderer-active'>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      'renderer-active': {
        entry: [
          () => {
            const renderer = createAudioRendererActor({
              audioContext: context.audioContext.get()!,
              // No paused gating here: the adapter suspends the
              // AudioContext on pause, which freezes the hardware clock and
              // every scheduled source. Rate 0 would instead produce an
              // infinite clock segment (duration ÷ 0) and sources whose
              // `playbackRate` stays 0 after resume — a permanent stall.
              getPlaybackRate: () => peek(state.playoutRate) ?? 1,
              getJoinAnchorUs: makeJoinAnchor(context.audioSubscriberActor, state.targetLatency, latencyConfig),
            });
            context.audioRendererActor.set(renderer);
            return () => {
              renderer.destroy();
              context.audioRendererActor.set(undefined);
            };
          },
          // The audio clock is the master clock: publish it as
          // `state.currentTime` on a UI-friendly cadence.
          () => {
            const timer = setInterval(() => {
              const clockUs = peek(context.audioRendererActor)?.getClockTimeUs();
              if (clockUs !== undefined) {
                state.currentTime.set(clockUs / 1_000_000);
                return;
              }
              // No audio scheduled — a video-only catalog, or audio that
              // hasn't started. The video renderer's last presented frame is
              // then the only progress signal, and `currentTime` is the only
              // thing the media-element facade derives readiness from: without
              // this fallback video-only playback renders fine but never
              // leaves HAVE_METADATA, so the shell buffers forever.
              const presentedUs = peek(context.videoRendererActor)?.snapshot.get().context.lastPresentedTimestampUs;
              if (presentedUs !== undefined) state.currentTime.set(presentedUs / 1_000_000);
            }, CLOCK_PUBLISH_INTERVAL_MS);
            return () => clearInterval(timer);
          },
        ],
        effects: [
          () => {
            const renderer = peek(context.audioRendererActor);
            if (!renderer) return;
            const subscriber = context.audioSubscriberActor.get();
            if (!subscriber) {
              renderer.setTrack(null, null);
              return;
            }
            renderer.setTrack(subscriber, toAudioDecoderConfig(subscriber.track as MoqAudioTrack));
          },
        ],
      },
    },
  });
}

/**
 * @example
 * const reactor = setupAudioRenderer.setup({ state, context });
 */
export const setupAudioRenderer = defineBehavior({
  stateKeys: ['playoutRate', 'targetLatency', 'currentTime'],
  contextKeys: ['audioContext', 'audioSubscriberActor', 'audioRendererActor', 'videoRendererActor'],
  setup: setupAudioRendererSetup,
});

// =============================================================================
// Video
// =============================================================================

function setupVideoRendererSetup({
  state,
  context,
  config,
}: {
  state: {
    playoutRate: ReadonlySignal<number | undefined>;
    targetLatency: ReadonlySignal<number | undefined>;
    paused: ReadonlySignal<boolean | undefined>;
  };
  context: {
    renderSurface: ReadonlySignal<HTMLCanvasElement | OffscreenCanvas | undefined>;
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioRendererActor: ReadonlySignal<AudioRendererActor | undefined>;
    videoRendererActor: Signal<VideoRendererActor | undefined>;
  };
  config?: MoqRendererConfig;
}): Reactor<'preconditions-unmet' | 'renderer-active' | 'destroying' | 'destroyed'> {
  const latencyConfig: LatencyControlConfig = { ...DEFAULT_LATENCY_CONTROL_CONFIG, ...config?.latency };
  const derivedStateSignal = computed(() =>
    context.renderSurface.get() ? ('renderer-active' as const) : ('preconditions-unmet' as const)
  );

  return createMachineReactor<'preconditions-unmet' | 'renderer-active'>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      'renderer-active': {
        entry: () => {
          const renderer = createVideoRendererActor({
            canvas: context.renderSurface.get()!,
            // Presentation is scheduled against the audio master clock by
            // frame timestamp; without audio the renderer self-clocks.
            getClockTimeUs: () => peek(context.audioRendererActor)?.getClockTimeUs(),
            // `paused` gates the rate to 0: without audio there is no
            // master clock to freeze, and the self-clock's rate-change
            // re-anchoring makes rate 0 hold exactly and resume from the
            // hold point.
            getPlaybackRate: () => (peek(state.paused) ? 0 : (peek(state.playoutRate) ?? 1)),
            // Only consulted on the self-clock path: with audio present the
            // master clock already carries the edge anchor.
            getJoinAnchorUs: makeJoinAnchor(context.videoSubscriberActor, state.targetLatency, latencyConfig),
          });
          context.videoRendererActor.set(renderer);
          return () => {
            renderer.destroy();
            context.videoRendererActor.set(undefined);
          };
        },
        effects: [
          () => {
            const renderer = peek(context.videoRendererActor);
            if (!renderer) return;
            const subscriber = context.videoSubscriberActor.get();
            if (!subscriber) {
              renderer.setTrack(null, null);
              return;
            }
            renderer.setTrack(subscriber, toVideoDecoderConfig(subscriber.track as MoqVideoTrack));
          },
        ],
      },
    },
  });
}

/**
 * @example
 * const reactor = setupVideoRenderer.setup({ state, context });
 */
export const setupVideoRenderer = defineBehavior({
  stateKeys: ['playoutRate', 'targetLatency', 'paused'],
  contextKeys: ['renderSurface', 'videoSubscriberActor', 'audioRendererActor', 'videoRendererActor'],
  setup: setupVideoRendererSetup,
});
