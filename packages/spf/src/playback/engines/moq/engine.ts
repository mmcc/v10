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
import { setupAudioRenderer, setupVideoRenderer } from '../../behaviors/dom/setup-moq-renderers';
import type { ApplyCatalogUpdate } from '../../behaviors/resolve-catalog';
import { resolveCatalog } from '../../behaviors/resolve-catalog';
import { setupMoqSession } from '../../behaviors/setup-moq-session';
import { subscribeSelectedAudioTrack, subscribeSelectedVideoTrack } from '../../behaviors/subscribe-selected-tracks';
import { type LatencyControlConfig, type PlayoutState, syncLatency } from '../../behaviors/sync-latency';
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
 * `currentTime` is **derived from the audio master clock** (written by the
 * audio renderer behavior, not read from a media element).
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
  /** Consumer-set target latency in seconds (input slot). */
  targetLatency?: number;
  measuredLatency?: number;
  playoutRate?: number;
  playoutState?: PlayoutState;
  /** Derived from the audio master clock (media seconds). */
  currentTime?: number;
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
  /** Latency-controller tuning (`syncLatency`). */
  latency?: Partial<LatencyControlConfig>;
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

      // Selection → make-before-break subscription handoff.
      subscribeSelectedVideoTrack,
      subscribeSelectedAudioTrack,

      // Arrival timing → bandwidthState (ABR re-picks tracks; the
      // subscribe behaviors execute the switch).
      trackMoqBandwidth,

      // Renderers, fed from the subscriber jitter buffers; audio owns the
      // master clock and currentTime.
      setupVideoRenderer,
      setupAudioRenderer,

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
