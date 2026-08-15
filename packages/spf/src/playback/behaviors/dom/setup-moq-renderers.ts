/**
 * **Wire subscriber jitter buffers into the WebCodecs renderers.** Four
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
 * - `trackPlayoutHealth` — owns `state.framesDropped` and
 *   `state.audioUnderruns`: the renderers' quality-cost counters, which
 *   lived inside the actors and were readable from nowhere. Separate from
 *   the clock above because it has a different consumer and a different
 *   cadence, and always composed because instrumentation that only exists
 *   when adaptation is on cannot measure whether adaptation helped.
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
import {
  joinAnchorUs,
  preferredTargetLatencySeconds,
  resolveTargetLatencySeconds,
  TIMELINE_DISCONTINUITY_US,
} from '../../../media/moq/timeline';
import {
  type AudioContextLike,
  type AudioRendererActor,
  createAudioRendererActor,
} from '../../actors/dom/audio-renderer';
import { createVideoRendererActor, type VideoRendererActor } from '../../actors/dom/video-renderer';
import type { TrackSubscriberActor } from '../../actors/track-subscriber';
import { type LatencyControlConfig, type PlayoutClockOwner, resolveLatencyControlConfig } from '../sync-latency';

// =============================================================================
// Shared state/context shapes
// =============================================================================

export interface MoqRendererState {
  playoutRate?: number;
  /** Consumer-set target latency in seconds; the anchor's distance from the live edge. */
  targetLatency?: number;
  /** Adaptive controller's proposal in seconds; ranks below `targetLatency`. */
  adaptiveTargetLatency?: number;
  /** Frames the video renderer discarded for arriving behind the clock. */
  framesDropped?: number;
  /** Times the audio schedule ran dry (see `AudioRendererContext.underruns`). */
  audioUnderruns?: number;
  /**
   * Adapter-written pause flag; `undefined` means playing. Gates the
   * renderers' playout rate to 0 — the video self-clock re-anchors on rate
   * changes, so rate 0 holds presentation exactly and resumes from the
   * hold point (there is no audio master clock to freeze in video-only
   * playback).
   */
  paused?: boolean;
  currentTime?: number;
  /**
   * Which renderer `currentTime` was last sampled from, and `undefined` when
   * neither is producing a position. Owned by `trackPlayoutTime` and read by
   * `syncLatency`, which can only call `newest buffered − currentTime` a
   * latency if it measures the edge of the track that position came from, and
   * only while that position is still live — `currentTime` holds its last
   * value when the clock stops, so this is what says it stopped.
   */
  playoutClockOwner?: PlayoutClockOwner;
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
  adaptiveTargetLatencySignal: ReadonlySignal<number | undefined>,
  latency: LatencyControlConfig
): (() => number | undefined) | undefined {
  if (!latency.joinAtEdge) return undefined;
  return () => {
    const subscriber = peek(subscriberSignal);
    const newestTimestampUs = subscriber?.snapshot.get().context.newestTimestampUs;
    if (newestTimestampUs === undefined) return undefined;
    // Same resolution `syncLatency` performs, from the same two input
    // slots — the clocks and the controller must aim at one number, and
    // the adaptive proposal has to reach both or the slew would chase an
    // edge the controller is not steering toward.
    const targetSeconds = resolveTargetLatencySeconds(
      preferredTargetLatencySeconds(peek(targetLatencySignal), peek(adaptiveTargetLatencySignal)),
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
 *
 * **An absent edge takes the video clock too.** `makeEdgeTargetUs` yields
 * `undefined` while the subscriber's snapshot has no `newestTimestampUs`, and the
 * renderer consumes this anchor in exactly one place: as the threshold below which
 * it discards buffered audio unheard. An absent threshold is therefore not a
 * neutral default but *no trim at all* — the schedule starts at the oldest frame
 * the renderer is holding.
 *
 * Those two are wired separately. The anchor peeks the subscriber signal when the
 * renderer asks, while the frame source is pushed in by the `setTrack` effect
 * below and trimmed on the renderer's own tick. So the renderer can be asked for a
 * threshold while the subscriber it reads reports nothing and the buffer it would
 * trim already holds frames — audio behind the running video clock, played instead
 * of dropped. Deferring to the video clock keeps this function's invariant applying
 * in the one case that could not clamp: audio with no edge of its own.
 *
 * With no video clock — an audio-only broadcast — the anchor stays absent and the
 * oldest-buffered default stands, which is right: nothing else is steering, and
 * there is no second timeline to agree with.
 *
 * **Unless the video clock is a whole timeline step ahead of the audio
 * delivery edge.** The forward clamp assumes the two tracks share a
 * timeline; a publisher that re-anchors the audio timeline on a capture
 * source switch breaks that, and the video clock — still on the departed
 * timeline — then sits past everything the new timeline will deliver for
 * a long time (a backward re-anchor: forever). Clamping onto it would
 * discard every arriving audio frame unheard. A video clock more than
 * `TIMELINE_DISCONTINUITY_US` past the audio *edge* (the newest frame
 * delivered, so the furthest any same-timeline clock could plausibly
 * read) is therefore ignored, and the audio edge anchors alone.
 */
function makeAudioJoinAnchor(
  subscriberSignal: ReadonlySignal<TrackSubscriberActor | undefined>,
  targetLatencySignal: ReadonlySignal<number | undefined>,
  adaptiveTargetLatencySignal: ReadonlySignal<number | undefined>,
  latency: LatencyControlConfig,
  videoRendererSignal: ReadonlySignal<VideoRendererActor | undefined>
): (() => number | undefined) | undefined {
  if (!latency.joinAtEdge) return undefined;
  return () => {
    const subscriber = peek(subscriberSignal);
    const newestTimestampUs = subscriber?.snapshot.get().context.newestTimestampUs;
    const videoClockUs = peek(videoRendererSignal)?.getClockTimeUs();
    if (newestTimestampUs === undefined) return videoClockUs;
    // Same resolution `syncLatency` and `makeEdgeTargetUs` perform, from
    // the same input slots — the clocks and the controller aim at one number.
    const targetSeconds = resolveTargetLatencySeconds(
      preferredTargetLatencySeconds(peek(targetLatencySignal), peek(adaptiveTargetLatencySignal)),
      subscriber?.track.moq.targetLatency,
      latency.defaultTargetLatency
    );
    const anchorUs = joinAnchorUs(newestTimestampUs, targetSeconds);
    if (videoClockUs === undefined) return anchorUs;
    if (videoClockUs - newestTimestampUs > TIMELINE_DISCONTINUITY_US) return anchorUs;
    return videoClockUs > anchorUs ? videoClockUs : anchorUs;
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
    adaptiveTargetLatency: ReadonlySignal<number | undefined>;
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
  const latencyConfig: LatencyControlConfig = resolveLatencyControlConfig(config?.latency);
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
              state.adaptiveTargetLatency,
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
  stateKeys: ['playoutRate', 'targetLatency', 'adaptiveTargetLatency'],
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
    adaptiveTargetLatency: ReadonlySignal<number | undefined>;
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
  const latencyConfig: LatencyControlConfig = resolveLatencyControlConfig(config?.latency);
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
            getTargetClockUs: makeEdgeTargetUs(
              context.videoSubscriberActor,
              state.targetLatency,
              state.adaptiveTargetLatency,
              latencyConfig
            ),
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
  stateKeys: ['playoutRate', 'targetLatency', 'adaptiveTargetLatency', 'paused'],
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
  state: {
    currentTime: Signal<number | undefined>;
    playoutClockOwner: Signal<PlayoutClockOwner | undefined>;
  };
  context: {
    audioRendererActor: ReadonlySignal<AudioRendererActor | undefined>;
    videoRendererActor: ReadonlySignal<VideoRendererActor | undefined>;
  };
}): () => void {
  const timer = setInterval(() => {
    const clockUs = peek(context.audioRendererActor)?.getClockTimeUs();
    if (clockUs !== undefined) {
      // Owner before position, so no reader can see a position attributed to
      // the wrong clock. Both are written from this one sample: which clock
      // produced the number is as much a part of it as the number, and it is
      // knowable *only* here — `getClockTimeUs()` is undefined until the
      // audio renderer has actually scheduled, which no amount of looking at
      // subscribers or AudioContexts reveals.
      state.playoutClockOwner.set('audio');
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
    //
    // It reports the *current* track only — the renderer clears it on
    // `setTrack` — so it is a live position and not a high-water mark. It has
    // to be: this is where the owner is named, and naming video on a frame
    // from a track that has been replaced points `syncLatency` at a position
    // that has stopped advancing.
    const presentedUs = peek(context.videoRendererActor)?.snapshot.get().context.lastPresentedTimestampUs;
    if (presentedUs !== undefined) {
      state.playoutClockOwner.set('video');
      state.currentTime.set(presentedUs / 1_000_000);
      return;
    }
    // **Neither clock produced a position, so there is no owner.** Both can
    // stop at once: an audio track switch runs `setTrack`, which closes the
    // decoder and empties the schedule, so `getClockTimeUs()` is undefined
    // again until the replacement is scheduled — and a video renderer
    // replaced alongside it has presented nothing yet. A video-only
    // broadcast reaches the same state on its own, through the second
    // branch above: the video renderer's `setTrack` clears
    // `lastPresentedTimestampUs` with the decoded queue it described, so
    // there is no position again until the replacement presents, and no
    // audio clock to hand over to meanwhile. Leaving the last name
    // standing is worse than clearing it, because `syncLatency` measures the
    // delivery edge of whichever track the owner names: the refilling
    // replacement would be controlled against a position that has stopped,
    // reading further behind on every evaluation until it skips a group on a
    // stream nobody is playing.
    //
    // The *position* is left where it was, deliberately. `currentTime` is
    // also the media element's `currentTime` — the facade reads `undefined`
    // as 0 — and the track-handoff promotion gate's due-time reference, where
    // `undefined` means "promote immediately". Clearing it would report a
    // seek to zero and open a gate whose whole job is to stay shut. The owner
    // is the signal that the position is no longer live; the position stays
    // the last one that was.
    state.playoutClockOwner.set(undefined);
  }, CLOCK_PUBLISH_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * **Publish the playout position as `state.currentTime`** (media seconds),
 * sampled from the audio master clock when audio is scheduled and from the
 * video renderer's last presented frame otherwise — **and publish which of
 * the two it was** as `state.playoutClockOwner`.
 *
 * The owner is not bookkeeping. `syncLatency` measures `newest buffered −
 * currentTime`, which is only a latency if the edge and the position come
 * from the same track, and nothing outside this interval can tell which
 * track the position came from: the audio renderer's `getClockTimeUs()` is
 * undefined until it has actually scheduled a buffer, so an audio
 * subscriber, an AudioContext, even a filling audio jitter buffer can all be
 * present while the position on offer is still video's last presented frame.
 * A controller inferring the owner from those instead measures across two
 * timebases for the whole of that window. Owner and position are therefore
 * written together, owner first, from one sample.
 *
 * When neither clock offers a position the owner is cleared and the position
 * is not. `currentTime` has two other readers that treat `undefined` as a
 * statement rather than an absence — the media element's `currentTime`, and
 * the handoff promotion gate — so the last known position stands, and the
 * owner is what says it is no longer live.
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
  stateKeys: ['currentTime', 'playoutClockOwner'],
  contextKeys: ['audioRendererActor', 'videoRendererActor'],
  setup: trackPlayoutTimeSetup,
});

// =============================================================================
// Playout health
// =============================================================================

const HEALTH_PUBLISH_INTERVAL_MS = 500;

function trackPlayoutHealthSetup({
  state,
  context,
}: {
  state: {
    framesDropped: Signal<number | undefined>;
    audioUnderruns: Signal<number | undefined>;
  };
  context: {
    audioRendererActor: ReadonlySignal<AudioRendererActor | undefined>;
    videoRendererActor: ReadonlySignal<VideoRendererActor | undefined>;
  };
}): () => void {
  const timer = setInterval(() => {
    state.framesDropped.set(peek(context.videoRendererActor)?.snapshot.get().context.framesDropped);
    state.audioUnderruns.set(peek(context.audioRendererActor)?.snapshot.get().context.underruns);
  }, HEALTH_PUBLISH_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * **Publish the renderers' quality-cost counters as engine state**:
 * `framesDropped` (video presented-late discards) and `audioUnderruns`
 * (times the audio schedule ran dry).
 *
 * Both already exist inside the renderer actors and neither was readable
 * from outside them. They are the *cost* half of any latency decision —
 * "the target came down" is only half an answer without "and nothing
 * started dropping" — so they are published whether or not adaptation is
 * running: an A/B whose control arm is uninstrumented cannot be read.
 * `adaptLatencyTarget` is the other reader, which is why this is a
 * separate always-on behavior rather than part of it.
 *
 * Interval-sampled rather than effect-driven on purpose: `framesDropped`
 * lives in the same actor snapshot as `lastPresentedTimestampUs`, so an
 * effect over it would re-run on every presented frame to copy a number
 * that changes far more rarely.
 *
 * @example
 * const cleanup = trackPlayoutHealth.setup({ state, context });
 */
export const trackPlayoutHealth = defineBehavior({
  stateKeys: ['framesDropped', 'audioUnderruns'],
  contextKeys: ['audioRendererActor', 'videoRendererActor'],
  setup: trackPlayoutHealthSetup,
});
