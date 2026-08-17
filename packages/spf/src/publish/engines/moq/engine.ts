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
  CaptureStatus,
  CaptureTrackFacts,
  PublishErrorFacts,
} from '../../behaviors/dom/acquire-capture-source';
import { acquireCameraSource, acquireMicrophone, acquireScreenShare } from '../../behaviors/dom/acquire-capture-source';
import { applyTrackToggles } from '../../behaviors/dom/apply-track-toggles';
import type { CaptureDeviceFacts } from '../../behaviors/dom/enumerate-capture-devices';
import { enumerateCaptureDevices } from '../../behaviors/dom/enumerate-capture-devices';
import type {
  ActiveEncodingsFacts,
  EncoderSupportFacts,
  SelectEncoderConfig,
  VideoEncodeTuning,
} from '../../behaviors/dom/probe-encoder-support';
import { probeEncoderSupport } from '../../behaviors/dom/probe-encoder-support';
import { pumpMediaFrames } from '../../behaviors/dom/pump-media-frames';
import type { EncoderInitDataFacts } from '../../behaviors/dom/setup-encoder-actors';
import { setupEncoderActors } from '../../behaviors/dom/setup-encoder-actors';
import type { PreviewSource } from '../../behaviors/dom/sync-preview';
import { syncPreview } from '../../behaviors/dom/sync-preview';
import type { PublishSessionStatus } from '../../behaviors/open-publish-session';
import { openPublishSession } from '../../behaviors/open-publish-session';
import type { DataTrackProducer, PublishDataTrackConfig } from '../../behaviors/setup-track-publishers';
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
  CaptureStatus,
  CaptureTrackFacts,
  ConnectPublishTransport,
  DataTrackProducer,
  EncodedChunkSink,
  EncodedChunkSinkMeta,
  EncoderInitDataFacts,
  EncoderSupportFacts,
  PreviewSource,
  PublishDataTrackConfig,
  PublishEndpoint,
  PublishErrorFacts,
  PublishSessionActor,
  PublishSessionStatus,
  PublishStatsFacts,
  SelectEncoderConfig,
  TrackPublisherActor,
  VideoEncoderActor,
  VideoEncodeTuning,
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
  /** Camera acquisition; additive with `screenShareActive`, not exclusive. */
  cameraActive?: boolean;
  /** Screen-share acquisition; additive with `cameraActive`, not exclusive. */
  screenShareActive?: boolean;
  /**
   * Microphone acquisition without a video source — the audio-only
   * publish seam. Either video intent still implies the mic; this slot
   * makes mic capture (and a session gated on it alone) possible when
   * neither is set.
   */
  micActive?: boolean;
  /** Selected camera; empty string defers to the platform default. */
  videoInputDeviceId?: string;
  /** Selected microphone; empty string defers to the platform default. */
  audioInputDeviceId?: string;
  /** Which capture stream the preview element mirrors. */
  previewSource?: PreviewSource;
  /** Mute outgoing camera video (track disabled, capture keeps running). */
  cameraMuted?: boolean;
  /** Mute outgoing microphone audio (track disabled, capture keeps running). */
  micMuted?: boolean;
  // -- facts (behaviors write) --
  captureDevices?: CaptureDeviceFacts[];
  cameraState?: CaptureStatus;
  screenShareState?: CaptureStatus;
  micState?: CaptureStatus;
  cameraTracks?: CaptureTrackFacts;
  screenTracks?: CaptureTrackFacts;
  micTracks?: CaptureTrackFacts;
  encoderSupport?: EncoderSupportFacts;
  activeEncodings?: ActiveEncodingsFacts;
  /** Decoder init data per kind, reported by the live encoders (`setupEncoderActors`). */
  encoderInitData?: EncoderInitDataFacts;
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
  /** Acquired capture streams (each owned by its acquire behavior). */
  cameraStream?: MediaStream | undefined;
  screenStream?: MediaStream | undefined;
  micStream?: MediaStream | undefined;
  /** Encoder actors (owned by `setupEncoderActors`). */
  cameraEncoderActor?: VideoEncoderActor | undefined;
  screenEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
  /** Publish transport session (owned by `openPublishSession`). */
  publishSessionActor?: PublishSessionActor | undefined;
  /** Per-track MOQT publishers (owned by `setupTrackPublishers`). */
  catalogTrackPublisher?: TrackPublisherActor | undefined;
  videoTrackPublisher?: TrackPublisherActor | undefined;
  screenTrackPublisher?: TrackPublisherActor | undefined;
  audioTrackPublisher?: TrackPublisherActor | undefined;
  /**
   * Producer handles for the config-declared application data tracks,
   * keyed by track name (owned by `setupTrackPublishers`). Present while
   * the publish session's track publishers are up; a page holding one
   * across a session rebuild must re-read the slot.
   */
  dataTrackProducers?: Readonly<Record<string, DataTrackProducer>> | undefined;
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
  /** Camera video tuning (an array per kind is the simulcast seam, later). */
  camera?: VideoEncodeTuning;
  /**
   * @deprecated Renamed to {@link MoqPublishEngineConfig.camera} when screen
   * share became a peer video source. Still honored when `camera` is absent;
   * `camera` wins when both are given.
   */
  video?: VideoEncodeTuning;
  /** Screen-share video tuning; defaults to a lower framerate/bitrate than `camera` (static degrade-screen-first). */
  screen?: VideoEncodeTuning;
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
  /**
   * Application data tracks published on the broadcast beside the media —
   * timed metadata, overlays, and other page-produced payload streams.
   * Each is registered and served by the engine like the media tracks
   * (same announce, same catalog) and exposed as a page-facing producer
   * handle on `context.dataTrackProducers`.
   */
  dataTracks?: PublishDataTrackConfig[];
  /** Transport seam; default constructs a real `WebTransport`. */
  connectTransport?: ConnectPublishTransport;
  /** MSF catalog-JSON builder seam; default `buildMsfCatalog`. */
  buildCatalog?: BuildMsfCatalog;
}

/**
 * Materialize the consumer-input slots no composed behavior produces and
 * hand the composition signal refs to `onSignalsReady`.
 */
const shareSignals = makeShareSignals<MoqPublishEngineState, MoqPublishEngineContext>(
  [
    'endpoint',
    'publishActivated',
    'cameraActive',
    'screenShareActive',
    'micActive',
    'videoInputDeviceId',
    'audioInputDeviceId',
    'previewSource',
    'cameraMuted',
    'micMuted',
  ],
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
  const trackPublisherSlot = {
    camera: () => contextRef?.videoTrackPublisher,
    screen: () => contextRef?.screenTrackPublisher,
    audio: () => contextRef?.audioTrackPublisher,
  };
  const routeToTrackPublishers: EncodedChunkSink = (packaged, meta) => {
    const slot = trackPublisherSlot[meta.track]();
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
    // The `video` → `camera` rename is resolved here, before the config
    // reaches `probeEncoderSupport`: that behavior knows only `camera`, so a
    // client still passing `video` would otherwise be silently ignored.
    camera: config.camera ?? config.video,
    chunkSink: config.chunkSink ?? routeToTrackPublishers,
  };
  const composition = createComposition(
    [
      enumerateCaptureDevices,
      acquireCameraSource,
      acquireScreenShare,
      acquireMicrophone,
      syncPreview,
      applyTrackToggles,
      probeEncoderSupport,
      setupEncoderActors,
      pumpMediaFrames,
      trackPublishStats,
      // Teardown-order constraint: composition cleanups run in array
      // order, so `setupTrackPublishers` must precede `openPublishSession`
      // — on destroy the track publishers quiesce and FIN each track's
      // live subscription streams while the session (and its transport)
      // is still alive; the session's bounded close-drain then flushes
      // those FINs (and the NAMESPACE_DONE retraction) before the
      // transport closes.
      setupTrackPublishers,
      openPublishSession,
      deriveCatalog,
      shareSignals,
    ],
    {
      config: engineConfig,
      initialState: {
        publishActivated: false,
        cameraActive: false,
        screenShareActive: false,
        micActive: false,
        videoInputDeviceId: '',
        audioInputDeviceId: '',
        previewSource: 'camera',
        cameraMuted: false,
        micMuted: false,
        cameraState: 'idle',
        screenShareState: 'idle',
        micState: 'idle',
        sessionStatus: 'idle',
      },
    }
  );
  contextRef = composition.context;
  return composition;
}
