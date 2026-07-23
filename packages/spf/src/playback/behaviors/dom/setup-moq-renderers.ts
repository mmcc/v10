/**
 * **Wire subscriber jitter buffers into the WebCodecs renderers.** Two
 * behaviors, one per leg:
 *
 * - `setupAudioRenderer` — owns `context.audioRendererActor` (created when
 *   `context.audioContext` appears) and points it at the active audio
 *   subscriber. The audio renderer owns the **master clock**, so this
 *   behavior also owns `state.currentTime`: a playout-cadence interval
 *   publishes the clock as seconds (the MoQ engine has no HTMLMediaElement
 *   to read time from).
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
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import { toAudioDecoderConfig, toVideoDecoderConfig } from '../../../media/moq/codec-mapping';
import type { MoqAudioTrack, MoqVideoTrack } from '../../../media/moq/parse-catalog';
import {
  type AudioContextLike,
  type AudioRendererActor,
  createAudioRendererActor,
} from '../../actors/dom/audio-renderer';
import { createVideoRendererActor, type VideoRendererActor } from '../../actors/dom/video-renderer';
import type { TrackSubscriberActor } from '../../actors/track-subscriber';

// =============================================================================
// Shared state/context shapes
// =============================================================================

export interface MoqRendererState {
  playoutRate?: number;
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

// =============================================================================
// Audio
// =============================================================================

function setupAudioRendererSetup({
  state,
  context,
}: {
  state: {
    playoutRate: ReadonlySignal<number | undefined>;
    paused: ReadonlySignal<boolean | undefined>;
    currentTime: Signal<number | undefined>;
  };
  context: {
    audioContext: ReadonlySignal<AudioContextLike | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioRendererActor: Signal<AudioRendererActor | undefined>;
  };
}): Reactor<'preconditions-unmet' | 'renderer-active' | 'destroying' | 'destroyed'> {
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
              // Rate 0 while paused for consistency with the video leg —
              // the adapter also suspends the AudioContext on pause.
              getPlaybackRate: () => (peek(state.paused) ? 0 : (peek(state.playoutRate) ?? 1)),
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
              if (clockUs !== undefined) state.currentTime.set(clockUs / 1_000_000);
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
  stateKeys: ['playoutRate', 'paused', 'currentTime'],
  contextKeys: ['audioContext', 'audioSubscriberActor', 'audioRendererActor'],
  setup: setupAudioRendererSetup,
});

// =============================================================================
// Video
// =============================================================================

function setupVideoRendererSetup({
  state,
  context,
}: {
  state: {
    playoutRate: ReadonlySignal<number | undefined>;
    paused: ReadonlySignal<boolean | undefined>;
  };
  context: {
    renderSurface: ReadonlySignal<HTMLCanvasElement | OffscreenCanvas | undefined>;
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioRendererActor: ReadonlySignal<AudioRendererActor | undefined>;
    videoRendererActor: Signal<VideoRendererActor | undefined>;
  };
}): Reactor<'preconditions-unmet' | 'renderer-active' | 'destroying' | 'destroyed'> {
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
  stateKeys: ['playoutRate', 'paused'],
  contextKeys: ['renderSurface', 'videoSubscriberActor', 'audioRendererActor', 'videoRendererActor'],
  setup: setupVideoRendererSetup,
});
