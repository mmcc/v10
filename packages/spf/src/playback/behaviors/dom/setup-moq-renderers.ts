/**
 * **Wire subscriber jitter buffers into the WebCodecs renderers.** Three
 * behaviors:
 *
 * - `setupAudioRenderer` — owns `context.audioRendererActor` (created when
 *   `context.audioContext` appears) and points it at the active audio
 *   subscriber. The audio renderer owns the **master clock**.
 * - `setupVideoRenderer` — owns `context.videoRendererActor` (created when
 *   `context.renderSurface` appears), points it at the active video
 *   subscriber, and slaves its presentation to the audio renderer's clock
 *   when one exists (falling back to the renderer's self-clock for
 *   video-only playback).
 * - `trackPlayoutTime` — owns `state.currentTime`: a playout-cadence
 *   interval publishes whichever clock is running as seconds (the MoQ
 *   engine has no HTMLMediaElement to read time from). It is its own
 *   behavior rather than a second job of the audio side because it must
 *   run whenever *either* renderer exists: gated on the AudioContext it
 *   would go silent exactly in the video-only case it exists to cover, and
 *   `syncLatency` reads `currentTime` as its setpoint, so a starved clock
 *   is a stopped controller.
 *
 * The renderers apply `state.playoutRate` (latency-controller nudges)
 * through the `getPlaybackRate` seam — gated to 0 for video while
 * `state.paused` is set, so video-only playback actually freezes on pause
 * — and both re-point on subscriber-actor swaps, which is the moment a
 * make-before-break handoff completes; the renderer's keyframe gate
 * handles the decoder reconfiguration.
 *
 * Both also aim their clocks at the **delivery edge**: with
 * `latency.joinAtEdge` set they hand each renderer the live edge of its
 * own jitter buffer (newest buffered − target latency). The two legs use
 * it differently, which is why the option is named differently on each —
 * audio consults it once per join (`getJoinAnchorUs`; audio cannot
 * fast-forward a backlog without pitch artifacts, so it drops it), while
 * video consults it continuously (`getTargetClockUs`) and slews its
 * self-clock onto it. The controller in `sync-latency` steers latency at
 * coarse scale once playout is running; where the clocks *are* lives here,
 * because the renderers own them.
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
  /** Shared with `syncLatency`: `joinAtEdge`, the target the clocks aim at, and the slew bounds. */
  latency?: Partial<LatencyControlConfig>;
}

/**
 * The live edge of `subscriberSignal`'s jitter buffer, `targetLatency`
 * back: where the renderer's clock should be. `undefined` disables edge
 * tracking — the knob is off, there is no subscriber, or nothing has
 * arrived yet.
 */
function makeEdgeTargetUs(
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

/**
 * The audio join anchor: the audio buffer's live edge, but never behind a
 * video clock that is already running.
 *
 * Audio subscriptions can start late — an autoplay deferral unlocks on
 * first gesture, a sustained pause releases and rejoins — and their edge
 * is computed from a buffer that has only just started filling. Anchoring
 * there can land behind the video self-clock, and the video renderer only
 * re-anchors on *forward* discontinuities, so it would hold on its last
 * frame until the newly-installed master clock caught up to it. Clamping
 * forward is the same "never move the clock backwards" rule the video
 * renderer applies to its own anchor.
 */
function makeAudioJoinAnchor(
  subscriberSignal: ReadonlySignal<TrackSubscriberActor | undefined>,
  targetLatencySignal: ReadonlySignal<number | undefined>,
  latency: LatencyControlConfig,
  videoRendererSignal: ReadonlySignal<VideoRendererActor | undefined>
): (() => number | undefined) | undefined {
  const edgeTargetUs = makeEdgeTargetUs(subscriberSignal, targetLatencySignal, latency);
  if (!edgeTargetUs) return undefined;
  return () => {
    const anchorUs = edgeTargetUs();
    if (anchorUs === undefined) return undefined;
    const videoClockUs = peek(videoRendererSignal)?.getClockTimeUs();
    return videoClockUs !== undefined && videoClockUs > anchorUs ? videoClockUs : anchorUs;
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
  };
  context: {
    audioContext: ReadonlySignal<AudioContextLike | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioRendererActor: Signal<AudioRendererActor | undefined>;
    /** Read-only, for the join anchor's forward clamp below. */
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
        entry: () => {
          const renderer = createAudioRendererActor({
            audioContext: context.audioContext.get()!,
            // No paused gating here: the adapter suspends the
            // AudioContext on pause, which freezes the hardware clock and
            // every scheduled source. Rate 0 would instead produce an
            // infinite clock segment (duration ÷ 0) and sources whose
            // `playbackRate` stays 0 after resume — a permanent stall.
            getPlaybackRate: () => peek(state.playoutRate) ?? 1,
            getJoinAnchorUs: makeAudioJoinAnchor(
              context.audioSubscriberActor,
              state.targetLatency,
              latencyConfig,
              context.videoRendererActor
            ),
          });
          context.audioRendererActor.set(renderer);
          return () => {
            renderer.destroy();
            context.audioRendererActor.set(undefined);
          };
        },
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
  stateKeys: ['playoutRate', 'targetLatency'],
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
            // master clock already tracks the edge itself.
            getTargetClockUs: makeEdgeTargetUs(context.videoSubscriberActor, state.targetLatency, latencyConfig),
            clockSlewRate: latencyConfig.clockSlewRate,
            clockSlewToleranceUs: latencyConfig.clockSlewTolerance * 1_000_000,
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

// =============================================================================
// Playout clock
// =============================================================================

function trackPlayoutTimeSetup({
  state,
  context,
}: {
  state: { currentTime: Signal<number | undefined> };
  context: {
    audioRendererActor: ReadonlySignal<AudioRendererActor | undefined>;
    videoRendererActor: ReadonlySignal<VideoRendererActor | undefined>;
  };
}): () => void {
  const timer = setInterval(() => {
    const clockUs = peek(context.audioRendererActor)?.getClockTimeUs();
    if (clockUs !== undefined) {
      state.currentTime.set(clockUs / 1_000_000);
      return;
    }
    // No audio scheduled — a video-only catalog, an autoplay deferral, or
    // audio that hasn't started. The video renderer's last presented frame
    // is then the only progress signal, and it is what `syncLatency`
    // measures its latency against; `currentTime` is also the only thing
    // the media-element facade derives readiness from, so without this
    // fallback video-only playback renders fine but never leaves
    // HAVE_METADATA and the shell buffers forever.
    const presentedUs = peek(context.videoRendererActor)?.snapshot.get().context.lastPresentedTimestampUs;
    if (presentedUs !== undefined) state.currentTime.set(presentedUs / 1_000_000);
  }, CLOCK_PUBLISH_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * **Publish the playout position as `state.currentTime`** (media seconds),
 * sampled from the audio master clock when audio is scheduled and from the
 * video renderer's last presented frame otherwise.
 *
 * Ungated on purpose. Its two consumers — the media-element facade's
 * readiness derivation and `syncLatency`'s setpoint — both need a value in
 * exactly the configurations a gate would exclude (no AudioContext, audio
 * deferred behind an autoplay unlock, audio released by a sustained
 * pause), and sampling two absent renderers costs one no-op interval.
 *
 * @example
 * const cleanup = trackPlayoutTime.setup({ state, context });
 */
export const trackPlayoutTime = defineBehavior({
  stateKeys: ['currentTime'],
  contextKeys: ['audioRendererActor', 'videoRendererActor'],
  setup: trackPlayoutTimeSetup,
});
