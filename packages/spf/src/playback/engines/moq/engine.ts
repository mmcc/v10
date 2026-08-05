import {
  type Composition,
  type ContextSignals,
  createComposition,
  type StateSignals,
} from '../../../core/composition/create-composition';
import { makeShareSignals, type ShareSignalsConfig } from '../../../core/composition/share-signals';
import type { QualityConfig } from '../../../media/abr/quality-selection';
import type { AudioTrack, MaybeResolvedPresentation, TextTrack, VideoTrack } from '../../../media/types';
import type { BandwidthConfig, BandwidthState } from '../../../network/bandwidth-estimator';
import type { AudioContextLike, AudioRendererActor } from '../../actors/dom/audio-renderer';
import type { VideoRendererActor } from '../../actors/dom/video-renderer';
import type { CreateMoqTransport, MoqAuthProvider, MoqSessionActor } from '../../actors/moq-session';
import type { TrackSubscriberActor } from '../../actors/track-subscriber';
import { type AdaptiveLatencyConfig, adaptLatencyTarget } from '../../behaviors/adapt-latency-target';
import {
  setupAudioRenderer,
  setupVideoRenderer,
  trackPlayoutHealth,
  trackPlayoutTime,
} from '../../behaviors/dom/setup-moq-renderers';
import type { ApplyCatalogUpdate } from '../../behaviors/resolve-catalog';
import { resolveCatalog } from '../../behaviors/resolve-catalog';
import { setupMoqSession } from '../../behaviors/setup-moq-session';
import { subscribeSelectedAudioTrack, subscribeSelectedVideoTrack } from '../../behaviors/subscribe-selected-tracks';
import { suspendMediaWhilePaused } from '../../behaviors/suspend-media-while-paused';
import {
  type LatencyControlConfig,
  type PlayoutClockOwner,
  type PlayoutState,
  syncLatency,
} from '../../behaviors/sync-latency';
import { DEFAULT_MOQ_BANDWIDTH_CONFIG, trackMoqBandwidth } from '../../behaviors/track-moq-bandwidth';
import { switchAudioTrack, switchTextTrack, switchVideoTrack } from '../../behaviors/track-switching';

// ============================================================================
// MoQ Engine State & Context
// ============================================================================

/**
 * State shape for the MoQ playback engine — the union of all state
 * required by its composed behaviors.
 *
 * Notable differences from the HLS engine: latency-control slots
 * (`targetLatency` / `measuredLatency` / `playoutRate` / `playoutState`)
 * exist because playout is clock-steered rather than element-driven, and
 * `currentTime` is **derived from whichever playout clock is running**
 * (written by `trackPlayoutTime`, not read from a media element).
 */
export interface MoqEngineState {
  /** A caller writes `{ url: 'moqt://…#msf:…' }`; `resolveCatalog` populates the rest. */
  presentation?: MaybeResolvedPresentation;
  preload?: 'auto' | 'metadata' | 'none';
  loadActivated?: boolean;
  selectedVideoTrackId?: string;
  selectedAudioTrackId?: string;
  selectedTextTrackId?: string;
  bandwidthState?: BandwidthState;
  userVideoTrackSelection?: Partial<VideoTrack>;
  userAudioTrackSelection?: Partial<AudioTrack>;
  userTextTrackSelection?: Partial<TextTrack> | 'off';
  /**
   * Adapter-written pause flag. The renderers gate their playout rate to 0
   * while set — without it, video-only playback (no audio master clock to
   * freeze) would keep presenting on the self-clock while paused.
   * `undefined` means playing, so engine-only drivers never pause by default.
   */
  paused?: boolean;
  /**
   * Set by `suspendMediaWhilePaused` once a pause outlives its hold
   * window; the subscribe behaviors release the media subscriptions while
   * set (the catalog subscription stays open) and rejoin at the live edge
   * on resume.
   */
  mediaSuspended?: boolean;
  /**
   * Adapter-written autoplay-policy gate: set when playback begins
   * without a user gesture while the AudioContext is suspended (autoplay).
   * The audio subscribe behavior releases its subscription while set —
   * video plays on the renderer self-clock — and the adapter clears it
   * once a resume() settles, rejoining audio at the live edge.
   */
  audioSuspended?: boolean;
  /** Consumer-set target latency in seconds (input slot). */
  targetLatency?: number;
  /**
   * Consumer opt-in to adaptive latency (input slot). `undefined` defers
   * to `config.adaptiveLatency.enabled`, which is off.
   */
  adaptiveLatencyEnabled?: boolean;
  /**
   * `adaptLatencyTarget`'s proposed target in seconds, or `undefined`
   * while adaptation is off or warming up. Ranks below `targetLatency`
   * and above the catalog target.
   */
  adaptiveTargetLatency?: number;
  /**
   * The setpoint `syncLatency` resolved and is actually holding, in
   * seconds — the only slot that states the *resolved* target rather than
   * an input to the resolution.
   */
  effectiveTargetLatency?: number;
  /** Real edge-to-playout latency in seconds, measured by `syncLatency`. */
  measuredLatency?: number;
  /** Catch-up group skips since the latency controller became active. */
  catchUpSkips?: number;
  /** Video frames discarded for arriving behind the clock. */
  framesDropped?: number;
  /** Times the audio schedule ran dry. */
  audioUnderruns?: number;
  playoutRate?: number;
  playoutState?: PlayoutState;
  /** Playout position in media seconds (audio master clock, else video). */
  currentTime?: number;
  /**
   * Which renderer `currentTime` came from, published alongside it by
   * `trackPlayoutTime`, and `undefined` while neither clock is producing a
   * position. The latency controller measures the delivery edge of *that*
   * track, since a depth taken against another one's clock is a subtraction
   * across two timebases — and measures nothing at all without an owner, since
   * `currentTime` holds its last value rather than clearing.
   */
  playoutClockOwner?: PlayoutClockOwner;
}

/**
 * Context shape for the MoQ playback engine: the session actor, the
 * per-type subscriber actors (each with a `pending*` sibling so old + new
 * subscriptions overlap during make-before-break handoff), the renderer
 * actors, and the platform surfaces the adapter provides (`renderSurface`
 * canvas + `audioContext`).
 */
export interface MoqEngineContext {
  moqSessionActor?: MoqSessionActor;
  videoSubscriberActor?: TrackSubscriberActor;
  pendingVideoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
  pendingAudioSubscriberActor?: TrackSubscriberActor;
  videoRendererActor?: VideoRendererActor;
  audioRendererActor?: AudioRendererActor;
  renderSurface?: HTMLCanvasElement | OffscreenCanvas;
  audioContext?: AudioContextLike;
}

export type MoqEngineSignals = {
  state: StateSignals<MoqEngineState>;
  context: ContextSignals<MoqEngineContext>;
};

/**
 * Configuration for the MoQ playback engine. Each option is consumed by
 * the appropriate behavior — the engine itself has no config beyond what
 * its behaviors read.
 */
export interface MoqEngineConfig extends ShareSignalsConfig<MoqEngineState, MoqEngineContext> {
  /** Transport factory override (tests / relays needing special setup). */
  createMoqTransport?: CreateMoqTransport;
  /** MSF §11.4 token workflow: initial supply + expiry refresh. */
  authProvider?: MoqAuthProvider;
  /** Override MSF catalog parsing (`resolveCatalog`). */
  applyCatalogUpdate?: ApplyCatalogUpdate;
  /** Bandwidth estimate in bps before enough arrival samples exist. */
  initialBandwidth?: number;
  /** ABR quality tuning for the reused `track-switching` ranker. */
  quality?: Partial<QualityConfig>;
  /** Arrival-timing estimator tuning (`trackMoqBandwidth`). */
  moqBandwidth?: Partial<BandwidthConfig>;
  /** Latency tuning: the controller (`syncLatency`) plus the renderers' join-at-edge anchor. */
  latency?: Partial<LatencyControlConfig>;
  /**
   * Adaptive-latency tuning (`adaptLatencyTarget`), including its
   * `enabled` switch — **off by default**, so an untouched engine holds
   * the fixed setpoint `latency` describes and this behavior registers no
   * timer. Deliberately its own object rather than a flag inside
   * `latency`: `latency` is shared verbatim with the renderers and the
   * pause-suspension window, and the adaptive knobs mean nothing to
   * either. The two are still coupled — `adaptLatencyTarget` validates
   * its rate bounds against `latency.clockSlewRate` and `intervalMs` and
   * throws on a combination whose control loops cannot settle.
   */
  adaptiveLatency?: Partial<AdaptiveLatencyConfig>;
  /**
   * Continuous pause duration, in seconds, before media subscriptions
   * release (`suspendMediaWhilePaused`). Defaults to target latency +
   * `latency.catchUpThreshold` — the point where the latency controller
   * starts discarding the paused buffer anyway.
   */
  pauseHoldSeconds?: number;
  preferredSubtitleLanguage?: string;
  includeForcedTracks?: boolean;
  enableDefaultTrack?: boolean;
}

// ============================================================================
// MoQ Playback Engine
// ============================================================================

/**
 * Materialize the consumer-input slots no composed behavior produces
 * (`user*TrackSelection` — track-switching only reads them) and hand the
 * composition signal refs to `onSignalsReady`.
 */
const shareSignals = makeShareSignals<MoqEngineState, MoqEngineContext>([
  'userVideoTrackSelection',
  'userAudioTrackSelection',
  'userTextTrackSelection',
]);

/**
 * Create a MoQ playback engine.
 *
 * Composes SPF behaviors into a reactive pipeline for MoQ/MSF playback
 * over WebTransport + WebCodecs: session setup, catalog resolution, the
 * *reused* track-selection/ABR machinery over the shared media model,
 * make-before-break subscription handoff, and clock-steered rendering
 * with latency control. There is no MSE column — rendering is
 * VideoDecoder→canvas and AudioDecoder→Web Audio, with the audio clock as
 * master.
 *
 * The `syncPreload`/`trackLoadTriggers` element behaviors are not
 * composed: with no `HTMLMediaElement`, the adapter writes
 * `state.preload` / `state.loadActivated` directly.
 *
 * @example
 * ```ts
 * let signals: MoqEngineSignals;
 * const engine = createMoqEngine({
 *   onSignalsReady: (refs) => {
 *     signals = refs;
 *   },
 * });
 *
 * signals.context.renderSurface.set(canvas);
 * signals.context.audioContext.set(new AudioContext());
 * signals.state.presentation.set({ url: 'moqt://relay.example.com/live#msf:live--catalog' });
 * signals.state.loadActivated.set(true);
 *
 * await engine.destroy();
 * ```
 */
export function createMoqEngine(config: MoqEngineConfig = {}): Composition<MoqEngineState, MoqEngineContext> {
  // The arrival-timing sampler reads `moqBandwidth` while the reused
  // `rankByBandwidth` ranker reads `bandwidth` — map one onto the other so
  // both share the MoQ-tuned estimator config. Without this the ranker
  // falls back to the segment-tuned defaults (128 KB `minTotalBytes`) and
  // never trusts push-sample estimates, and consumer `moqBandwidth`
  // overrides never reach it.
  const compositionConfig = {
    ...config,
    bandwidth: { ...DEFAULT_MOQ_BANDWIDTH_CONFIG, ...config.moqBandwidth },
  };
  return createComposition(
    [
      // Session first: owns the transport + MOQT session actor, gated on
      // preload/load-activation like manifest resolution is for HLS.
      setupMoqSession,
      // Catalog subscription → resolved Presentation (+ live updates).
      resolveCatalog,

      // REUSED from the HLS engine — selection operates on the shared
      // media model, so live (push) tracks rank and pick unchanged.
      switchVideoTrack,
      switchAudioTrack,
      // TODO(text-rendering): selection only — no text subscriber/renderer
      // behavior yet; do not expose a textTracks facade on the adapter until
      // one exists.
      switchTextTrack,

      // Sustained-pause gate the subscribe behaviors read: a pause that
      // outlives its hold window releases the media subscriptions (the
      // catalog subscription above stays open).
      suspendMediaWhilePaused,

      // Selection → make-before-break subscription handoff.
      subscribeSelectedVideoTrack,
      subscribeSelectedAudioTrack,

      // Arrival timing → bandwidthState (ABR re-picks tracks; the
      // subscribe behaviors execute the switch).
      trackMoqBandwidth,

      // Renderers, fed from the subscriber jitter buffers; audio owns the
      // master clock.
      setupVideoRenderer,
      setupAudioRenderer,
      // Whichever clock is running → state.currentTime. Before the
      // controller: it is the controller's setpoint.
      trackPlayoutTime,
      // Renderer cost counters → state. Before the adaptive controller,
      // which reads them as its failure feedback.
      trackPlayoutHealth,

      // Observed delivery → adaptiveTargetLatency. Before the controller
      // for the same reason `trackPlayoutTime` is: it supplies an input.
      // Inactive (and timer-free) unless adaptation is switched on.
      adaptLatencyTarget,

      // Target-latency hold: rate nudges / group-skip catch-up.
      syncLatency,

      // External read/write surface — last so initial signal setup has
      // happened before the consumer callback fires.
      shareSignals,
    ],
    {
      config: compositionConfig,
      // Seed bandwidthState so the first selection ranks on the
      // initial-bandwidth fallback instead of waiting for samples.
      initialState: {
        bandwidthState: {
          fastEstimate: 0,
          fastTotalWeight: 0,
          slowEstimate: 0,
          slowTotalWeight: 0,
          bytesSampled: 0,
        },
      },
    }
  );
}
