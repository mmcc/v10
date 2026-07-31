import {
  type Composition,
  type ContextSignals,
  createComposition,
  type StateSignals,
} from '../../../core/composition/create-composition';
import { makeShareSignals, type ShareSignalsConfig } from '../../../core/composition/share-signals';
import { peek } from '../../../core/signals/primitives';
import type { BuildMsfCatalog } from '../../../media/moq/build-catalog';
import type { AudioEncoderActor } from '../../actors/dom/audio-encoder';
import type { EncodedChunkSink, EncodedChunkSinkMeta } from '../../actors/dom/encoder-actor';
import type { VideoEncoderActor } from '../../actors/dom/video-encoder';
import type { TrackPublisherActor } from '../../actors/track-publisher';
import { deriveCatalog } from '../../behaviors/derive-catalog';
import type {
  CaptureSourceKind,
  CaptureSourceSelection,
  CaptureStatus,
  CaptureTrackFacts,
  CaptureTracksFacts,
  PublishErrorFacts,
} from '../../behaviors/dom/acquire-capture-source';
import { acquireCaptureSource } from '../../behaviors/dom/acquire-capture-source';
import { applyTrackToggles } from '../../behaviors/dom/apply-track-toggles';
import type { CaptureDeviceFacts } from '../../behaviors/dom/enumerate-capture-devices';
import { enumerateCaptureDevices } from '../../behaviors/dom/enumerate-capture-devices';
import type {
  ActiveEncodingsFacts,
  EncoderSupportFacts,
  SelectEncoderConfig,
} from '../../behaviors/dom/probe-encoder-support';
import { probeEncoderSupport } from '../../behaviors/dom/probe-encoder-support';
import { pumpMediaFrames } from '../../behaviors/dom/pump-media-frames';
import { setupEncoderActors } from '../../behaviors/dom/setup-encoder-actors';
import { syncPreview } from '../../behaviors/dom/sync-preview';
import type { PublishSessionStatus } from '../../behaviors/open-publish-session';
import { openPublishSession } from '../../behaviors/open-publish-session';
import { setupTrackPublishers } from '../../behaviors/setup-track-publishers';
import type { PublishStatsFacts } from '../../behaviors/track-publish-stats';
import { trackPublishStats } from '../../behaviors/track-publish-stats';
import type { ConnectPublishTransport, PublishEndpoint, PublishSessionActor } from '../../session/publish-session';

// The capture, encode, and transport value types are declared beside
// their owning behaviors/actors; re-exported here so the engine module
// stays the contract surface.
export type {
  ActiveEncodingsFacts,
  AudioEncoderActor,
  CaptureDeviceFacts,
  CaptureSourceKind,
  CaptureSourceSelection,
  CaptureStatus,
  CaptureTrackFacts,
  CaptureTracksFacts,
  ConnectPublishTransport,
  EncodedChunkSink,
  EncodedChunkSinkMeta,
  EncoderSupportFacts,
  PublishEndpoint,
  PublishErrorFacts,
  PublishSessionActor,
  PublishSessionStatus,
  PublishStatsFacts,
  SelectEncoderConfig,
  TrackPublisherActor,
  VideoEncoderActor,
};

/**
 * State shape for the MoQ publish engine — consumer intent slots (written
 * through {@link MoqPublishEngineConfig.onSignalsReady} refs by the
 * adapter) plus pipeline facts (written by behaviors).
 */
export interface MoqPublishEngineState {
  // -- intent (adapter writes) --
  /** Relay endpoint + namespace; `undefined` keeps the session idle. */
  endpoint?: PublishEndpoint | undefined;
  /** `publish()`/`unpublish()` — gates the transport session. */
  publishActivated?: boolean;
  /** Selected capture source; `undefined` releases capture. */
  captureSource?: CaptureSourceSelection | undefined;
  /** Mute outgoing video (track disabled, capture keeps running). */
  cameraMuted?: boolean;
  /** Mute outgoing audio (track disabled, capture keeps running). */
  micMuted?: boolean;
  // -- facts (behaviors write) --
  captureDevices?: CaptureDeviceFacts[];
  captureStatus?: CaptureStatus;
  captureTracks?: CaptureTracksFacts;
  encoderSupport?: EncoderSupportFacts;
  activeEncodings?: ActiveEncodingsFacts;
  sessionStatus?: PublishSessionStatus;
  publishStats?: PublishStatsFacts;
  publishError?: PublishErrorFacts | undefined;
}

/**
 * Context shape for the MoQ publish engine — platform objects and owned
 * resources.
 */
export interface MoqPublishEngineContext {
  /** Preview surface the capture stream is mirrored into (adapter writes). */
  previewElement?: HTMLVideoElement | undefined;
  /** The acquired capture stream (owned by the acquire behavior). */
  captureStream?: MediaStream | undefined;
  /** Encoder actors (owned by `setupEncoderActors`). */
  videoEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
  /** Publish transport session (owned by `openPublishSession`). */
  publishSessionActor?: PublishSessionActor | undefined;
  /** Per-track MOQT publishers (owned by `setupTrackPublishers`). */
  catalogTrackPublisher?: TrackPublisherActor | undefined;
  videoTrackPublisher?: TrackPublisherActor | undefined;
  audioTrackPublisher?: TrackPublisherActor | undefined;
}

/** Composition signal refs handed to {@link ShareSignalsConfig.onSignalsReady}. */
export interface MoqPublishEngineSignals {
  state: StateSignals<MoqPublishEngineState>;
  context: ContextSignals<MoqPublishEngineContext>;
}

// ============================================================================
// MoQ Publish Engine Config
// ============================================================================

export interface MoqPublishEngineConfig extends ShareSignalsConfig<MoqPublishEngineState, MoqPublishEngineContext> {
  /** Forced-keyframe cadence; each GoP becomes one MoQ group. */
  groupDurationSec?: number;
  /** Single-rendition video tuning (an array is the simulcast seam, later). */
  video?: { width?: number; height?: number; frameRate?: number; bitrate?: number; codec?: string };
  audio?: { bitrate?: number };
  /** Resolve probed encoder support into the active encodings. */
  selectEncoderConfig?: SelectEncoderConfig;
  /**
   * Packaged-chunk destination. Default: route each chunk to the matching
   * MOQT track publisher — override only to observe or replace transport.
   */
  chunkSink?: EncodedChunkSink;
  /** Encoder queue depth above which delta frames are dropped. */
  maxEncodeQueueSize?: number;
  /** `publishStats` sampling period; ~1 Hz default. */
  statsIntervalMs?: number;
  /** Groups the transport may fall behind before dropping to the keyframe. */
  maxQueuedGroups?: number;
  /** Transport seam; default constructs a real `WebTransport`. */
  connectTransport?: ConnectPublishTransport;
  /** MSF catalog-JSON builder seam; default `buildMsfCatalog`. */
  buildCatalog?: BuildMsfCatalog;
  /** Control-request response bound for the publish session. */
  requestTimeoutMs?: number;
}

/**
 * Materialize the consumer-input slots no composed behavior produces and
 * hand the composition signal refs to `onSignalsReady`.
 */
const shareSignals = makeShareSignals<MoqPublishEngineState, MoqPublishEngineContext>(
  ['endpoint', 'publishActivated', 'captureSource', 'cameraMuted', 'micMuted'],
  ['previewElement']
);

/**
 * Create a MoQ publish engine.
 *
 * The composition: capture (`getUserMedia`/`getDisplayMedia`) → WebCodecs
 * encode → MOQT publish over an in-repo publish session speaking the same
 * draft-19 dialect as the playback stack, publishing LOC-packaged tracks
 * plus an MSF catalog track.
 *
 * M1 composed the capture stage — device enumeration, capture-source
 * acquisition, preview mirroring, and mute toggles. M2 added the encode
 * stage: encoder-support probing, the encoder actor pair, the
 * frame-pumping loops, and `publishStats` sampling. M3 completes the
 * pipeline with the transport stage: the publish session
 * (`openPublishSession` owns `sessionStatus`), the per-track MOQT
 * publishers, and the catalog derivation — the default `chunkSink` now
 * routes packaged chunks into the track publishers, read lazily from
 * context so encoder wiring and transport lifetime stay decoupled.
 */
export function createMoqPublishEngine(
  config: MoqPublishEngineConfig = {}
): Composition<MoqPublishEngineState, MoqPublishEngineContext> {
  // Default chunk router: encoder output → the matching track publisher.
  // The context ref lands right after creation; `peek` keeps the sink
  // untracked wherever it is called from.
  let contextRef: ContextSignals<MoqPublishEngineContext> | undefined;
  const routeToTrackPublishers: EncodedChunkSink = (packaged, meta) => {
    const slot = meta.track === 'video' ? contextRef?.videoTrackPublisher : contextRef?.audioTrackPublisher;
    const publisher = slot === undefined ? undefined : peek(slot);
    publisher?.send({
      type: 'frame',
      payload: packaged.payload,
      properties: packaged.properties,
      keyframe: meta.keyframe,
      timestampUs: meta.timestampUs,
    });
  };

  const engineConfig: MoqPublishEngineConfig = {
    ...config,
    chunkSink: config.chunkSink ?? routeToTrackPublishers,
  };
  const composition = createComposition(
    [
      enumerateCaptureDevices,
      acquireCaptureSource,
      syncPreview,
      applyTrackToggles,
      probeEncoderSupport,
      setupEncoderActors,
      pumpMediaFrames,
      trackPublishStats,
      // Teardown-order constraint: composition cleanups run in array
      // order, so `setupTrackPublishers` must precede `openPublishSession`
      // — on destroy the track publishers quiesce and queue each track's
      // PUBLISH_DONE while the session (and its transport) is still alive;
      // the session's bounded close-drain then flushes those writes before
      // the transport closes.
      setupTrackPublishers,
      openPublishSession,
      deriveCatalog,
      shareSignals,
    ],
    {
      config: engineConfig,
      initialState: {
        publishActivated: false,
        cameraMuted: false,
        micMuted: false,
        captureStatus: 'idle',
        sessionStatus: 'idle',
      },
    }
  );
  contextRef = composition.context;
  return composition;
}
