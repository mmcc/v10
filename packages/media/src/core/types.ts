// ----------------------------------------
// Event primitives
// ----------------------------------------

export interface EventLike<Detail = void> {
  readonly type: string;
  readonly timeStamp: number;
  readonly detail?: Detail;
}

export interface EventTargetLike<Events extends { [K in keyof Events]: EventLike }> {
  addEventListener<K extends keyof Events & string>(
    type: K,
    listener: (event: Events[K]) => void,
    options?: { signal?: AbortSignal }
  ): void;
  removeEventListener<K extends keyof Events & string>(type: K, listener: (event: Events[K]) => void): void;
  dispatchEvent(event: EventLike): boolean;
}

export function TypedEventTarget<Events extends { [K in keyof Events]: EventLike }>() {
  return EventTarget as unknown as { new (): EventTargetLike<Events> };
}

// ----------------------------------------
// Shared value types
// ----------------------------------------

export type MediaFeatureAvailability = 'available' | 'unavailable' | 'unsupported';

// ----------------------------------------
// Controls
// ----------------------------------------

export interface MediaControlsCapability {
  controls: boolean;
}

// ----------------------------------------
// Playback
// ----------------------------------------

export interface MediaPlaybackEvents {
  play: EventLike;
  playing: EventLike;
  waiting: EventLike;
}

export interface MediaPlaybackCapability {
  play(): Promise<void>;
}

// ----------------------------------------
// Autoplay
// ----------------------------------------

export interface MediaAutoplayCapability {
  autoplay: boolean;
}

// ----------------------------------------
// Pause
// ----------------------------------------

export interface MediaPauseEvents {
  pause: EventLike;
  ended: EventLike;
}

export interface MediaPauseCapability {
  pause(): void;
  readonly paused: boolean;
  readonly ended: boolean;
}

// ----------------------------------------
// Seek
// ----------------------------------------

export interface MediaSeekEvents {
  timeupdate: EventLike;
  durationchange: EventLike;
  seeking: EventLike;
  seeked: EventLike;
  loadedmetadata: EventLike;
}

export interface MediaSeekCapability {
  currentTime: number;
  loop: boolean;
  readonly duration: number;
  readonly seeking: boolean;
}

// ----------------------------------------
// Source
// ----------------------------------------

export type MediaPreloadType = '' | 'none' | 'metadata' | 'auto';

const MediaReadyState = {
  HAVE_NOTHING: 0,
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
  HAVE_FUTURE_DATA: 3,
  HAVE_ENOUGH_DATA: 4,
} as const;

export type MediaReadyStateValue = (typeof MediaReadyState)[keyof typeof MediaReadyState];

export interface MediaSourceEvents {
  loadstart: EventLike;
  emptied: EventLike;
  canplay: EventLike;
  canplaythrough: EventLike;
  loadeddata: EventLike;
  abort: EventLike;
  stalled: EventLike;
  suspend: EventLike;
}

/** Result of {@link MediaSourceCapability.canPlayType}. */
export type CanPlayTypeResult = '' | 'maybe' | 'probably';

export interface MediaSourceCapability {
  src: string;
  readonly currentSrc: string;
  readonly readyState: MediaReadyStateValue | number;
  preload: MediaPreloadType;
  crossOrigin: string | null;
  load(): Promise<void> | void;
  canPlayType(type: string): CanPlayTypeResult;
}

// ----------------------------------------
// Volume
// ----------------------------------------

export interface MediaVolumeEvents {
  volumechange: EventLike;
}

export interface MediaVolumeCapability {
  volume: number;
  muted: boolean;
  defaultMuted: boolean;
}

// ----------------------------------------
// Playback rate
// ----------------------------------------

export interface MediaPlaybackRateEvents {
  ratechange: EventLike;
}

export interface MediaPlaybackRateCapability {
  playbackRate: number;
  defaultPlaybackRate: number;
}

// ----------------------------------------
// Buffer
// ----------------------------------------

export interface TimeRangeLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export interface MediaBufferEvents {
  progress: EventLike;
}

export interface MediaBufferCapability {
  readonly buffered: TimeRangeLike;
  readonly seekable: TimeRangeLike;
}

// ----------------------------------------
// Played
// ----------------------------------------

export interface MediaPlayedCapability {
  readonly played: TimeRangeLike;
}

// ----------------------------------------
// Error
// ----------------------------------------

export interface ErrorLike {
  readonly code: number;
  readonly message: string;
}

export interface MediaErrorEvents {
  error: EventLike;
}

export interface MediaErrorCapability {
  readonly error: ErrorLike | null;
}

// ----------------------------------------
// Text tracks
// ----------------------------------------

export interface TextCueLike {
  readonly startTime: number;
  readonly endTime: number;
  readonly text?: string;
}

export interface TextCueListLike {
  readonly length: number;
  [Symbol.iterator](): Iterator<TextCueLike>;
  getCueById?(id: string): TextCueLike | null;
}

/**
 * The kind of text track.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/TextTrack/kind
 */
export type TextTrackKind = 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata';

export interface TextTrackLike {
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  readonly id: string;
  readonly src?: string;
  mode: 'showing' | 'disabled' | 'hidden';
  readonly cues: TextCueListLike | null;
  addCue?(cue: TextCueLike): void;
}

export interface TextTrackListEvents {
  addtrack: EventLike;
  removetrack: EventLike;
  change: EventLike;
}

export interface TextTrackListLike extends EventTargetLike<TextTrackListEvents> {
  readonly length: number;
  readonly [index: number]: TextTrackLike;
  [Symbol.iterator](): Iterator<TextTrackLike>;
  getTrackById?(id: string): TextTrackLike | null;
}

export interface MediaTextTrackCapability {
  readonly textTracks: TextTrackListLike;
  addTextTrack(kind: TextTrackKind, label?: string, language?: string): TextTrackLike;
}

// ----------------------------------------
// Media tracks
// ----------------------------------------

interface MediaTrackEventLike<Track> extends EventLike {
  readonly track: Track;
}

interface MediaTrackListEvents<Track> {
  addtrack: MediaTrackEventLike<Track>;
  removetrack: MediaTrackEventLike<Track>;
  change: EventLike;
}

export interface AudioTrackLike {
  id: string | undefined;
  readonly kind: string | undefined;
  readonly label: string;
  readonly language: string;
  enabled: boolean;
  addRendition(src: string, codec?: string | undefined, bitrate?: number | undefined): AudioRenditionLike;
  removeRendition(rendition: AudioRenditionLike): void;
}

export interface AudioTrackListLike extends EventTargetLike<MediaTrackListEvents<AudioTrackLike>> {
  readonly length: number;
  readonly [index: number]: AudioTrackLike;
  [Symbol.iterator](): Iterator<AudioTrackLike>;
  getTrackById(id: string): AudioTrackLike | null;
}

export interface VideoTrackLike {
  id: string | undefined;
  readonly kind: string | undefined;
  readonly label: string;
  readonly language: string;
  selected: boolean;
  addRendition(
    src: string,
    width?: number | undefined,
    height?: number | undefined,
    codec?: string | undefined,
    bitrate?: number | undefined,
    frameRate?: number | undefined
  ): VideoRenditionLike;
  removeRendition(rendition: VideoRenditionLike): void;
}

export interface VideoTrackListLike extends EventTargetLike<MediaTrackListEvents<VideoTrackLike>> {
  readonly length: number;
  readonly [index: number]: VideoTrackLike;
  [Symbol.iterator](): Iterator<VideoTrackLike>;
  getTrackById(id: string): VideoTrackLike | null;
  readonly selectedIndex: number;
}

export interface MediaAudioTrackCapability {
  readonly audioTracks: AudioTrackListLike;
  addAudioTrack(kind: string, label?: string, language?: string): AudioTrackLike;
  removeAudioTrack(track: AudioTrackLike): void;
}

export interface MediaVideoTrackCapability {
  readonly videoTracks: VideoTrackListLike;
  addVideoTrack(kind: string, label?: string, language?: string): VideoTrackLike;
  removeVideoTrack(track: VideoTrackLike): void;
}

// ----------------------------------------
// Renditions
// ----------------------------------------

interface RenditionEventLike<Rendition> extends EventLike {
  readonly rendition: Rendition;
}

interface RenditionListEvents<Rendition> {
  addrendition: RenditionEventLike<Rendition>;
  removerendition: RenditionEventLike<Rendition>;
  change: EventLike;
}

export interface AudioRenditionLike {
  id: string | undefined;
  readonly bitrate: number | undefined;
  readonly codec: string | undefined;
  selected: boolean;
}

export interface AudioRenditionListLike extends EventTargetLike<RenditionListEvents<AudioRenditionLike>> {
  readonly length: number;
  readonly [index: number]: AudioRenditionLike;
  [Symbol.iterator](): Iterator<AudioRenditionLike>;
  getRenditionById(id: string): AudioRenditionLike | null;
  selectedIndex: number;
}

export interface VideoRenditionLike {
  id: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly bitrate: number | undefined;
  readonly frameRate: number | undefined;
  readonly codec: string | undefined;
  selected: boolean;
  active?: boolean | undefined;
}

interface VideoRenditionListEvents extends RenditionListEvents<VideoRenditionLike> {
  activechange: EventLike;
}

export interface VideoRenditionListLike extends EventTargetLike<VideoRenditionListEvents> {
  readonly length: number;
  readonly [index: number]: VideoRenditionLike;
  [Symbol.iterator](): Iterator<VideoRenditionLike>;
  getRenditionById(id: string): VideoRenditionLike | null;
  selectedIndex: number;
}

export interface MediaAudioRenditionCapability {
  readonly audioRenditions: AudioRenditionListLike;
}

export interface MediaVideoRenditionCapability {
  readonly videoRenditions: VideoRenditionListLike;
}

// ----------------------------------------
// Fullscreen
// ----------------------------------------

export interface MediaFullscreenCapability {
  readonly isFullscreen: boolean;
  requestFullscreen(): Promise<unknown>;
  exitFullscreen(): Promise<unknown>;
}

// ----------------------------------------
// Picture-in-picture
// ----------------------------------------

export interface MediaPictureInPictureEvents {
  enterpictureinpicture: EventLike;
  leavepictureinpicture: EventLike;
}

export interface MediaPictureInPictureCapability {
  readonly isPictureInPicture: boolean;
  disablePictureInPicture: boolean;
  requestPictureInPicture(): Promise<unknown>;
  exitPictureInPicture(): Promise<unknown>;
}

// ----------------------------------------
// Stream type
// ----------------------------------------

/**
 * Canonical values for {@link MediaStreamType}.
 *
 * - `ON_DEMAND` — a finite-duration asset (VOD). Scrubbing is generally
 *   supported across the full timeline.
 * - `LIVE` — a live or DVR stream. The seekable window may slide as new
 *   segments are published, and `duration` is typically `Infinity`.
 * - `UNKNOWN` — the stream type has not been determined yet (no source,
 *   or metadata has not loaded).
 */
export const MediaStreamTypes = {
  ON_DEMAND: 'on-demand',
  LIVE: 'live',
  UNKNOWN: 'unknown',
} as const;

export type MediaStreamType = (typeof MediaStreamTypes)[keyof typeof MediaStreamTypes];

export interface MediaStreamTypeEvents {
  streamtypechange: EventLike;
}

export interface MediaStreamTypeCapability {
  streamType: MediaStreamType;
}

export interface MediaLiveEvents {
  targetlivewindowchange: EventLike;
}

export interface MediaLiveCapability {
  /**
   * Presentation time marking the start of the Live Edge Window. Playing at
   * the live edge when `currentTime >= liveEdgeStart`. `NaN` when the stream
   * isn't live or the value is unknown.
   *
   * Derived — no dedicated change event; re-read when `seekable`,
   * `targetLiveWindow`, or `streamType` change.
   *
   * @see https://github.com/video-dev/media-ui-extensions/blob/main/proposals/0007-live-edge.md
   */
  readonly liveEdgeStart: number;
  /**
   * Offset representing the seekable range size for live content. `0` for
   * standard latency live, `Infinity` for DVR, `NaN` for on-demand or
   * unknown. Fires `targetlivewindowchange` when the value changes.
   */
  readonly targetLiveWindow: number;
}

// ----------------------------------------
// Remote playback
// ----------------------------------------

export interface RemotePlaybackEvents {
  connecting: EventLike;
  connect: EventLike;
  disconnect: EventLike;
}

export interface RemotePlaybackLike extends EventTargetLike<RemotePlaybackEvents> {
  readonly state: 'connecting' | 'connected' | 'disconnected';
  prompt(): Promise<void>;
  watchAvailability(callback: (available: boolean) => void): Promise<number>;
  cancelWatchAvailability(id?: number): Promise<void>;
}

export interface MediaRemotePlaybackCapability {
  readonly remote: RemotePlaybackLike;
  disableRemotePlayback: boolean;
}

// ----------------------------------------
// Plays inline (video-only)
// ----------------------------------------

export interface MediaPlaysInlineCapability {
  playsInline: boolean;
}

// ----------------------------------------
// Poster (video-only)
// ----------------------------------------

export interface MediaPosterCapability {
  poster: string;
}

// ----------------------------------------
// Content metadata
// ----------------------------------------

/** A media-owned content value. `undefined` means the key is absent; `null` means it has no current value. */
export type MediaContentValue = string | null | undefined;

/** Standardized content metadata reported by a media implementation. */
export type MediaContentData = Readonly<Record<string, MediaContentValue>>;

/** Events emitted when a media implementation's content data changes. */
export interface MediaContentDataEvents {
  contentdatachange: EventLike;
}

/** Optional media-owned content metadata. */
export interface MediaContentDataCapability {
  readonly contentData: MediaContentData | undefined;
}

// ----------------------------------------
// Video dimensions (video-only)
// ----------------------------------------

export interface MediaVideoDimensionsEvents {
  resize: EventLike;
}

export interface MediaVideoDimensionsCapability {
  readonly videoWidth: number;
  readonly videoHeight: number;
}

// ----------------------------------------
// Config
// ----------------------------------------

export interface MediaConfigCapability {
  config: Record<string, unknown>;
}

// ----------------------------------------
// Publish (publisher-only)
// ----------------------------------------

/**
 * Lifecycle of an outbound publish session.
 *
 * - `idle` — no session; `publish()` starts one.
 * - `connecting` — transport/session setup is in flight.
 * - `live` — the session is established and media is being published.
 * - `stopping` — an orderly shutdown (unpublish or server GOAWAY) is
 *   draining; a new `publish()` must wait for `idle`.
 * - `error` — the session failed; `publishError` holds the cause and
 *   `publish()` may retry.
 */
export type MediaPublishSessionState = 'idle' | 'connecting' | 'live' | 'stopping' | 'error';

export interface MediaPublishEvents {
  publishstatechange: EventLike;
}

export interface MediaPublishCapability {
  /** Publish endpoint URL (e.g. a MoQ relay's WebTransport URL). */
  publishEndpoint: string;
  /** Namespace/path the media is published under at the endpoint. */
  publishNamespace: string;
  /**
   * Bearer token presented to the endpoint when the session is
   * established; empty string presents none.
   */
  publishAuthToken: string;
  /** Current publish session lifecycle. Fires `publishstatechange`. */
  readonly publishState: MediaPublishSessionState;
  /**
   * Epoch milliseconds when the session last entered `live`. Held through
   * `stopping` (so timers keep showing the elapsed session time while the
   * shutdown drains) and `NaN` once the session settles on `idle` or
   * `error`. Re-read on `publishstatechange`.
   */
  readonly publishStartedAt: number;
  /** The failure that moved `publishState` to `error`, if any. */
  readonly publishError: ErrorLike | null;
  /**
   * Start publishing. Resolves when the session is `live`; rejects when
   * the attempt fails or is abandoned by `unpublish()` (`play()`-like).
   * Rejects immediately when its preconditions are unmet: a publish
   * endpoint must be configured and an active capture source must exist
   * (`captureState` is `active`) — it never waits for either to appear.
   * Calling it again while `publishState` is `error` tears the failed
   * session down, starts a fresh attempt, and settles on that attempt's
   * outcome.
   */
  publish(): Promise<void>;
  /** Stop publishing and tear the session down. */
  unpublish(): void;
}

// ----------------------------------------
// Capture (publisher-only)
// ----------------------------------------

/** Which kind of video feeds capture. Additive — both may be active at once. */
export type MediaCaptureSourceKind = 'camera' | 'screen';

/**
 * Lifecycle of one capture pipeline.
 *
 * - `idle` — not selected; nothing captured yet.
 * - `acquiring` — being acquired (usually a permission prompt).
 * - `active` — tracks are live and previewable.
 * - `denied` — the user (or platform policy) refused access.
 * - `ended` — the source ended outside our control (device unplugged,
 *   screen share stopped from browser UI).
 */
export type MediaCaptureState = 'idle' | 'acquiring' | 'active' | 'denied' | 'ended';

export interface MediaCaptureSourceEvents {
  capturesourcechange: EventLike;
  capturestatechange: EventLike;
  capturestreamchange: EventLike;
}

/**
 * Camera, screen-share, and microphone acquisition — additive, not
 * exclusive: activating any source never releases another, and each can be
 * toggled independently. The microphone is also implied by video intent:
 * it is acquired while either video source is active (keyed for
 * re-acquisition on
 * {@link MediaCaptureDevicesCapability.audioInputDeviceId}), so
 * {@link micActive} only needs to be written for an audio-only capture.
 *
 * The intent slots are consumed by the pipeline on terminal outcomes:
 * after a permission denial or an out-of-band end (device unplugged,
 * browser-native "Stop sharing") the slot reads `false` again while the
 * matching state holds `denied`/`ended` — so writing `true` always means
 * "attempt acquisition now", including retries.
 */
export interface MediaCaptureSourceCapability {
  /** Camera acquisition; `true` acquires (prompting as needed), `false` releases. Fires `capturesourcechange`. */
  cameraActive: boolean;
  /** Screen-share acquisition; `true` opens the OS picker, `false` stops sharing. Fires `capturesourcechange`. */
  screenShareActive: boolean;
  /**
   * Microphone acquisition without a video source — the audio-only capture
   * seam. Either video source active still implies the mic; this is
   * acquisition intent, not a mute. Fires `capturesourcechange`.
   */
  micActive: boolean;
  /** Camera pipeline lifecycle. Fires `capturestatechange`. */
  readonly cameraState: MediaCaptureState;
  /** Screen-share pipeline lifecycle. Fires `capturestatechange`. */
  readonly screenShareState: MediaCaptureState;
  /**
   * Microphone pipeline lifecycle. Fires `capturestatechange`. `idle`
   * while video is active means capture is running without audio (no
   * usable microphone); `denied`/`ended` surface a blocked or unplugged
   * mic so UIs can say why a live broadcast has no sound.
   */
  readonly micState: MediaCaptureState;
  /**
   * Live camera stream while `cameraState` is `active`, else `null`.
   * Fires `capturestreamchange`. Exposed for consumers that must read
   * tracks directly (e.g. an audio level meter) — high-frequency data
   * should never round-trip through state.
   */
  readonly cameraStream: MediaStreamLike | null;
  /** Live screen-share stream while `screenShareState` is `active`, else `null`. Fires `capturestreamchange`. */
  readonly screenShareStream: MediaStreamLike | null;
}

/**
 * Structural stand-in for the DOM `MediaStream` — keeps this contract
 * DOM-free. (Not to be confused with {@link MediaStreamType}, which
 * classifies live vs on-demand playback.)
 */
export interface MediaStreamLike {
  readonly id: string;
  getAudioTracks(): { enabled: boolean }[];
  getVideoTracks(): { enabled: boolean }[];
}

/** One selectable capture input device. */
export interface MediaCaptureDeviceInfo {
  readonly deviceId: string;
  readonly kind: 'videoinput' | 'audioinput';
  /** Human-readable name; empty until the user grants device permission. */
  readonly label: string;
}

export interface MediaCaptureDevicesEvents {
  capturedeviceschange: EventLike;
}

export interface MediaCaptureDevicesCapability {
  /** Known capture input devices. Fires `capturedeviceschange`. */
  readonly captureDevices: readonly MediaCaptureDeviceInfo[];
  /**
   * Selected camera; empty string defers to the platform default. Hosts
   * must fire `capturedeviceschange` when a selection changes — consumers
   * re-read selections from that event.
   */
  videoInputDeviceId: string;
  /** Selected microphone; empty string defers to the platform default. */
  audioInputDeviceId: string;
}

export interface MediaCaptureToggleEvents {
  capturetogglechange: EventLike;
}

export interface MediaCaptureToggleCapability {
  /**
   * Whether outgoing video is muted. Muting disables the track (black
   * frames) without stopping capture or encoding.
   */
  cameraMuted: boolean;
  /** Whether outgoing audio is muted (silence without stopping capture). */
  micMuted: boolean;
}

/** Point-in-time health counters for an active publish session. */
export interface MediaPublishStats {
  /** Encoded video frames per second over the last sample window; `NaN` when unknown. */
  readonly encodedFps: number;
  /** Outgoing video bitrate in bits per second; `NaN` when unknown. */
  readonly videoBitrate: number;
  /** Outgoing audio bitrate in bits per second; `NaN` when unknown. */
  readonly audioBitrate: number;
  /** Frames dropped before encoding (capture or encoder backpressure). */
  readonly droppedFrames: number;
  /** Whole groups abandoned because the transport fell behind. */
  readonly droppedGroups: number;
  /** Total bytes handed to the transport this session. */
  readonly bytesSent: number;
  /** Active subscriptions at the relay, when known; `NaN` otherwise. */
  readonly subscriberCount: number;
}

export interface MediaPublishStatsEvents {
  publishstatsupdate: EventLike;
}

export interface MediaPublishStatsCapability {
  /**
   * Latest sampled stats, `null` before the first sample. Updated at a low
   * frequency (~1 Hz); fires `publishstatsupdate`.
   */
  readonly publishStats: MediaPublishStats | null;
}

// ----------------------------------------
// Base Media
// ----------------------------------------

export interface MediaEvents extends MediaPlaybackEvents {}

export interface Media<Events extends { [K in keyof Events]: EventLike } = MediaEvents>
  extends MediaPlaybackCapability,
    EventTargetLike<Events> {}

// ----------------------------------------
// Composed shapes
// ----------------------------------------

export interface MediaFullEvents
  extends MediaEvents,
    MediaPauseEvents,
    MediaSeekEvents,
    MediaSourceEvents,
    MediaVolumeEvents,
    MediaPlaybackRateEvents,
    MediaBufferEvents,
    MediaErrorEvents,
    TextTrackListEvents,
    MediaStreamTypeEvents,
    MediaLiveEvents,
    MediaContentDataEvents {}

export interface MediaFull<Events extends { [K in keyof Events]: EventLike } = MediaFullEvents>
  extends Media<Events>,
    MediaPauseCapability,
    MediaSeekCapability,
    MediaSourceCapability,
    MediaVolumeCapability,
    MediaPlaybackRateCapability,
    MediaBufferCapability,
    MediaPlayedCapability,
    MediaErrorCapability,
    MediaTextTrackCapability,
    MediaStreamTypeCapability,
    MediaLiveCapability,
    MediaContentDataCapability,
    MediaRemotePlaybackCapability,
    MediaControlsCapability,
    MediaAutoplayCapability {}

export interface VideoEvents extends MediaFullEvents, MediaPictureInPictureEvents, MediaVideoDimensionsEvents {}

export interface Video
  extends MediaFull<VideoEvents>,
    MediaPlaysInlineCapability,
    MediaPosterCapability,
    MediaFullscreenCapability,
    MediaPictureInPictureCapability,
    MediaVideoDimensionsCapability {}

export interface AudioEvents extends MediaFullEvents {}

export interface Audio extends MediaFull<AudioEvents> {}

// ----------------------------------------
// Target shapes
// ----------------------------------------

export interface MediaTargetLike
  extends MediaPlaybackCapability,
    MediaPauseCapability,
    MediaSeekCapability,
    MediaSourceCapability,
    MediaVolumeCapability,
    MediaPlaybackRateCapability,
    MediaBufferCapability,
    MediaPlayedCapability,
    MediaErrorCapability,
    MediaTextTrackCapability,
    MediaRemotePlaybackCapability,
    MediaControlsCapability,
    MediaAutoplayCapability,
    Partial<MediaLiveCapability>,
    Partial<MediaStreamTypeCapability>,
    Partial<MediaContentDataCapability> {
  title: string;
}

export interface VideoTargetLike
  extends MediaTargetLike,
    MediaPosterCapability,
    MediaPlaysInlineCapability,
    MediaVideoDimensionsCapability {
  disablePictureInPicture: boolean;
  requestPictureInPicture(): Promise<unknown>;
  requestFullscreen(): Promise<unknown>;
}

export interface MediaEngineHost<Engine = unknown, Target = unknown> {
  readonly engine: Engine | null;
  attach?(target: Target): void;
  detach?(): void;
  destroy(): void;
}
