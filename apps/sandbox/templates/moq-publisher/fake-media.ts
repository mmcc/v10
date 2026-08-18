import type {
  ErrorLike,
  MediaCaptureDeviceInfo,
  MediaCaptureDevicesCapability,
  MediaCaptureSourceCapability,
  MediaCaptureSourceKind,
  MediaCaptureState,
  MediaCaptureToggleCapability,
  MediaPublishCapability,
  MediaPublishSessionState,
  MediaPublishStats,
  MediaPublishStatsCapability,
} from '@videojs/media';
import { HTMLVideoElementHost, type HTMLVideoTargetLike } from '@videojs/media/dom/video-host';

const CONNECT_DELAY_MS = 800;
const STOP_DELAY_MS = 250;
const STATS_INTERVAL_MS = 1000;
const FAKE_VIDEO_BITRATE = 2.5e6;
const FAKE_AUDIO_BITRATE = 1.28e5;

/**
 * Publisher media host with real capture and a fake publish transport.
 *
 * Capture is genuine `getUserMedia`/`getDisplayMedia`; `publish()` only
 * simulates a session (connect delay, `live`, ~1 Hz plausible stats) so the
 * publisher capability contracts can be exercised without a relay.
 *
 * Additive, not exclusive: camera and screen are two independent pipelines,
 * each pulling its own audio (unlike the real engine, which gives the
 * microphone its own always-on pipeline — see
 * `internal/design/spf/features/publisher-multi-source-capture.md`). That
 * extra independence isn't this fake's job to demonstrate; it only needs to
 * satisfy the additive capability contract for the sandbox's `?fake` mode.
 * `micActive` runs a third, audio-only pipeline for the explicit mic seam,
 * so a mic-only publish is drivable here too.
 */
export class FakePublishMedia
  extends HTMLVideoElementHost
  implements
    MediaPublishCapability,
    MediaCaptureSourceCapability,
    MediaCaptureDevicesCapability,
    MediaCaptureToggleCapability,
    MediaPublishStatsCapability
{
  publishEndpoint = '';
  publishNamespace = '';
  publishAuthToken = '';

  #cameraActive = false;
  #screenShareActive = false;
  #micActive = false;
  #cameraState: MediaCaptureState = 'idle';
  #screenShareState: MediaCaptureState = 'idle';
  #cameraStream: MediaStream | null = null;
  #screenShareStream: MediaStream | null = null;
  /** Owned by the explicit mic pipeline; never exposed or previewed. */
  #micStream: MediaStream | null = null;
  /** Bumped per kind to cancel in-flight acquisitions when it's re-toggled. */
  #cameraAcquireToken = 0;
  #screenAcquireToken = 0;
  #micAcquireToken = 0;
  /** Owned: losing the merged audio track doesn't end its stream, so `micState` has nothing live to read 'ended' off. */
  #micEnded = false;
  /** Owned: the explicit pipeline's in-flight/denied phases have no stream to derive from either. */
  #micAcquiring = false;
  #micDenied = false;

  #captureDevices: MediaCaptureDeviceInfo[] = [];
  #videoInputDeviceId = '';
  #audioInputDeviceId = '';

  #cameraMuted = false;
  #micMuted = false;

  #publishState: MediaPublishSessionState = 'idle';
  #publishStartedAt = Number.NaN;
  #publishError: ErrorLike | null = null;
  #publishStats: MediaPublishStats | null = null;
  #publishTimer: ReturnType<typeof setTimeout> | undefined;
  #statsTimer: ReturnType<typeof setInterval> | undefined;
  #pendingPublish: { reject: (reason: Error) => void } | null = null;

  /** The attached render target, kept as the concrete element so the preview can use `srcObject`. */
  #preview: HTMLVideoElement | null = null;
  #disposed = new AbortController();

  constructor() {
    super();
    navigator.mediaDevices?.addEventListener('devicechange', () => void this.#refreshDevices(), {
      signal: this.#disposed.signal,
    });
    void this.#refreshDevices();
  }

  override attach(target: HTMLVideoTargetLike): void {
    super.attach(target);
    this.#preview = target as unknown as HTMLVideoElement;
    this.#syncPreview();
  }

  override detach(): void {
    this.#clearPreview();
    this.#preview = null;
    super.detach();
  }

  override destroy(): void {
    this.#disposed.abort();
    this.#cameraAcquireToken++;
    this.#screenAcquireToken++;
    this.#micAcquireToken++;
    this.#clearPublishTimer();
    this.#stopStats();
    this.#pendingPublish?.reject(new Error('The media host was destroyed.'));
    this.#pendingPublish = null;
    this.#releaseStream('camera');
    this.#releaseStream('screen');
    this.#releaseMicStream();
    super.destroy();
  }

  // ── MediaCaptureSourceCapability ────────────────────────────────────────

  get cameraActive(): boolean {
    return this.#cameraActive;
  }

  set cameraActive(value: boolean) {
    if (value === this.#cameraActive) return;
    this.#cameraActive = value;
    this.dispatchEvent(new Event('capturesourcechange'));

    if (value) {
      void this.#acquire('camera');
    } else {
      this.#cameraAcquireToken++;
      this.#releaseStream('camera');
      this.#setCaptureState('camera', 'idle');
      this.#unpublishWithoutSources();
    }
  }

  get screenShareActive(): boolean {
    return this.#screenShareActive;
  }

  set screenShareActive(value: boolean) {
    if (value === this.#screenShareActive) return;
    this.#screenShareActive = value;
    this.dispatchEvent(new Event('capturesourcechange'));

    if (value) {
      void this.#acquire('screen');
    } else {
      this.#screenAcquireToken++;
      this.#releaseStream('screen');
      this.#setCaptureState('screen', 'idle');
      this.#unpublishWithoutSources();
    }
  }

  get micActive(): boolean {
    return this.#micActive;
  }

  set micActive(value: boolean) {
    if (value === this.#micActive) return;
    this.#micActive = value;
    this.dispatchEvent(new Event('capturesourcechange'));

    if (value) {
      void this.#acquireMic();
    } else {
      this.#micAcquireToken++;
      this.#updateMicState(() => {
        this.#releaseMicStream();
        this.#micAcquiring = false;
        this.#micDenied = false;
        this.#micEnded = false;
      });
      this.#unpublishWithoutSources();
    }
  }

  get cameraState(): MediaCaptureState {
    return this.#cameraState;
  }

  get screenShareState(): MediaCaptureState {
    return this.#screenShareState;
  }

  /**
   * Mostly derived: this fake merges mic audio into each video capture
   * stream (see the header note), and the explicit `micActive` pipeline
   * owns `#micStream`, so 'active' reads straight off the live streams.
   * The remaining phases need owned flags — losing a merged audio track
   * removes it from its stream without ending the stream itself, and the
   * explicit pipeline's acquiring/denied phases have no stream at all.
   */
  get micState(): MediaCaptureState {
    const hasAudio = (stream: MediaStream | null) => (stream?.getAudioTracks().length ?? 0) > 0;
    if (hasAudio(this.#micStream) || hasAudio(this.#cameraStream) || hasAudio(this.#screenShareStream)) {
      return 'active';
    }
    if (this.#micAcquiring) return 'acquiring';
    if (this.#micDenied) return 'denied';
    return this.#micEnded ? 'ended' : 'idle';
  }

  get cameraStream(): MediaStream | null {
    return this.#cameraState === 'active' ? this.#cameraStream : null;
  }

  get screenShareStream(): MediaStream | null {
    return this.#screenShareState === 'active' ? this.#screenShareStream : null;
  }

  // ── MediaCaptureDevicesCapability ───────────────────────────────────────

  get captureDevices(): readonly MediaCaptureDeviceInfo[] {
    return this.#captureDevices;
  }

  get videoInputDeviceId(): string {
    return this.#videoInputDeviceId;
  }

  set videoInputDeviceId(value: string) {
    if (value === this.#videoInputDeviceId) return;
    this.#videoInputDeviceId = value;
    this.#reacquireCamera();
  }

  get audioInputDeviceId(): string {
    return this.#audioInputDeviceId;
  }

  set audioInputDeviceId(value: string) {
    if (value === this.#audioInputDeviceId) return;
    this.#audioInputDeviceId = value;
    this.#reacquireCamera();
    this.#reacquireMic();
  }

  // ── MediaCaptureToggleCapability ────────────────────────────────────────

  get cameraMuted(): boolean {
    return this.#cameraMuted;
  }

  set cameraMuted(value: boolean) {
    if (value === this.#cameraMuted) return;
    this.#cameraMuted = value;
    for (const track of this.#cameraStream?.getVideoTracks() ?? []) track.enabled = !value;
    this.dispatchEvent(new Event('capturetogglechange'));
  }

  get micMuted(): boolean {
    return this.#micMuted;
  }

  set micMuted(value: boolean) {
    if (value === this.#micMuted) return;
    this.#micMuted = value;
    for (const track of this.#cameraStream?.getAudioTracks() ?? []) track.enabled = !value;
    for (const track of this.#screenShareStream?.getAudioTracks() ?? []) track.enabled = !value;
    for (const track of this.#micStream?.getAudioTracks() ?? []) track.enabled = !value;
    this.dispatchEvent(new Event('capturetogglechange'));
  }

  // ── MediaPublishCapability ──────────────────────────────────────────────

  get publishState(): MediaPublishSessionState {
    return this.#publishState;
  }

  get publishStartedAt(): number {
    return this.#publishStartedAt;
  }

  get publishError(): ErrorLike | null {
    return this.#publishError;
  }

  publish(): Promise<void> {
    if (this.#publishState === 'connecting' || this.#publishState === 'live' || this.#publishState === 'stopping') {
      return Promise.reject(new Error(`publish() is not allowed while the session is ${this.#publishState}.`));
    }
    if (
      this.#cameraState !== 'active' &&
      this.#screenShareState !== 'active' &&
      !(this.#micActive && this.micState === 'active')
    ) {
      this.#publishError = { code: 0, message: 'publish() requires an active capture source.' };
      this.#setPublishState('error');
      return Promise.reject(new Error(this.#publishError.message));
    }

    this.#publishError = null;
    this.#publishStats = null;
    this.#setPublishState('connecting');

    return new Promise<void>((resolve, reject) => {
      this.#pendingPublish = { reject };
      this.#publishTimer = setTimeout(() => {
        this.#publishTimer = undefined;
        this.#pendingPublish = null;
        this.#publishStartedAt = Date.now();
        this.#setPublishState('live');
        this.#startStats();
        resolve();
      }, CONNECT_DELAY_MS);
    });
  }

  unpublish(): void {
    if (this.#publishState === 'idle' || this.#publishState === 'stopping') return;

    this.#clearPublishTimer();
    this.#pendingPublish?.reject(new Error('unpublish() was called before the session went live.'));
    this.#pendingPublish = null;
    this.#stopStats();
    this.#publishStartedAt = Number.NaN;
    this.#publishError = null;

    if (this.#publishState === 'error') {
      this.#setPublishState('idle');
      return;
    }

    this.#setPublishState('stopping');
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = undefined;
      this.#setPublishState('idle');
    }, STOP_DELAY_MS);
  }

  // ── MediaPublishStatsCapability ─────────────────────────────────────────

  get publishStats(): MediaPublishStats | null {
    return this.#publishStats;
  }

  // ── Capture internals ───────────────────────────────────────────────────

  async #acquire(kind: MediaCaptureSourceKind): Promise<void> {
    const token = kind === 'camera' ? ++this.#cameraAcquireToken : ++this.#screenAcquireToken;
    this.#releaseStream(kind);
    this.#setCaptureState(kind, 'acquiring');

    try {
      const stream = kind === 'camera' ? await this.#getCameraStream() : await this.#getScreenStream();
      const current = kind === 'camera' ? this.#cameraAcquireToken : this.#screenAcquireToken;
      if (token !== current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.#adoptStream(kind, stream);
      // Device labels stay redacted until a grant, so refresh after acquiring.
      void this.#refreshDevices();
    } catch (error) {
      const current = kind === 'camera' ? this.#cameraAcquireToken : this.#screenAcquireToken;
      if (token !== current) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.#setCaptureState(kind, denied ? 'denied' : 'idle');
      this.#consumeIntent(kind);
    }
  }

  /**
   * Mirror the real capability contract: a pipeline that terminates
   * without consumer action (denied, failed, out-of-band ended) consumes
   * its intent flag, so toggles read false again and a retry is one
   * click. Sets the backing field directly — the setter's release path
   * would clobber the terminal state the UI needs.
   */
  #consumeIntent(kind: MediaCaptureSourceKind | 'mic'): void {
    if (kind === 'camera') this.#cameraActive = false;
    else if (kind === 'screen') this.#screenShareActive = false;
    else this.#micActive = false;
    this.dispatchEvent(new Event('capturesourcechange'));
    // Every involuntary-release caller (acquire failure, track-ended) routes
    // through here — a live session with nothing capturing must not stay live.
    this.#unpublishWithoutSources();
  }

  /** Shared by intent consumption and the consumer-release setters: no intent left means no session. */
  #unpublishWithoutSources(): void {
    if (this.#cameraActive || this.#screenShareActive || this.#micActive) return;
    if (this.#publishState === 'connecting' || this.#publishState === 'live') this.unpublish();
  }

  /** The explicit audio-only pipeline behind `micActive`; video capture keeps merging its own mic audio. */
  async #acquireMic(): Promise<void> {
    const token = ++this.#micAcquireToken;
    this.#updateMicState(() => {
      this.#releaseMicStream();
      this.#micAcquiring = true;
      this.#micDenied = false;
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: this.#audioInputDeviceId ? { deviceId: this.#audioInputDeviceId } : true,
      });
      if (token !== this.#micAcquireToken) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      for (const track of stream.getAudioTracks()) track.enabled = !this.#micMuted;
      this.#updateMicState(() => {
        this.#micAcquiring = false;
        this.#micEnded = false;
        this.#micStream = stream;
      });
      this.#watchMicTracks(stream);
      // Device labels stay redacted until a grant, so refresh after acquiring.
      void this.#refreshDevices();
    } catch (error) {
      if (token !== this.#micAcquireToken) return;
      this.#updateMicState(() => {
        this.#micAcquiring = false;
        this.#micDenied = error instanceof DOMException && error.name === 'NotAllowedError';
      });
      this.#consumeIntent('mic');
    }
  }

  /**
   * Mirrors `#setCaptureState`'s dedupe for the derived mic lifecycle:
   * merged video audio can hold `micState` at 'active' across explicit
   * pipeline changes, and an unchanged state must not fire the event.
   */
  #updateMicState(mutate: () => void): void {
    const before = this.micState;
    mutate();
    if (this.micState !== before) this.dispatchEvent(new Event('capturestatechange'));
  }

  #watchMicTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (this.#micStream !== stream) return;
          this.#updateMicState(() => {
            this.#releaseMicStream();
            this.#micEnded = true;
          });
          this.#consumeIntent('mic');
        },
        { once: true }
      );
    }
  }

  #releaseMicStream(): void {
    const stream = this.#micStream;
    if (!stream) return;
    this.#micStream = null;
    for (const track of stream.getTracks()) track.stop();
  }

  async #getCameraStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: this.#videoInputDeviceId ? { deviceId: this.#videoInputDeviceId } : true,
      audio: this.#audioInputDeviceId ? { deviceId: this.#audioInputDeviceId } : true,
    });
  }

  async #getScreenStream(): Promise<MediaStream> {
    // System/tab audio is never requested — the real screen path doesn't
    // either (multi-source design record, "System audio" decision), and it
    // keeps every audio track in an owned stream mic-owned, which is what
    // lets micState (and the mic-ended flag) derive from the streams alone.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: this.#audioInputDeviceId ? { deviceId: this.#audioInputDeviceId } : true,
      });
      for (const track of mic.getAudioTracks()) stream.addTrack(track);
    } catch {
      // A missing microphone must not kill the screen share; publish video-only.
    }
    return stream;
  }

  #adoptStream(kind: MediaCaptureSourceKind, stream: MediaStream): void {
    for (const track of stream.getVideoTracks()) track.enabled = !this.#cameraMuted;
    for (const track of stream.getAudioTracks()) track.enabled = !this.#micMuted;
    // A fresh acquisition that carries audio re-merges the mic — the prior 'ended' no longer applies.
    if (stream.getAudioTracks().length > 0) this.#micEnded = false;
    this.#watchTracks(kind, stream);
    if (kind === 'camera') this.#cameraStream = stream;
    else this.#screenShareStream = stream;
    this.#setCaptureState(kind, 'active');
    this.dispatchEvent(new Event('capturestreamchange'));
    this.#syncPreview();
  }

  #releaseStream(kind: MediaCaptureSourceKind): void {
    const stream = kind === 'camera' ? this.#cameraStream : this.#screenShareStream;
    if (!stream) return;
    if (kind === 'camera') this.#cameraStream = null;
    else this.#screenShareStream = null;
    for (const track of stream.getTracks()) track.stop();
    // The last source is gone — clean slate, back to 'idle' rather than a stale 'ended' outliving the capture that produced it.
    if (!this.#cameraStream && !this.#screenShareStream && !this.#micStream) this.#micEnded = false;
    this.dispatchEvent(new Event('capturestreamchange'));
    this.#syncPreview();
  }

  /** Ends outside our control (unplugged device, browser-UI "Stop sharing") land in `ended`. */
  #watchTracks(kind: MediaCaptureSourceKind, stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          const owner = kind === 'camera' ? this.#cameraStream : this.#screenShareStream;
          if (owner !== stream) return;
          if (track.kind === 'audio') {
            // The merged mic track is not the video pipeline — the real
            // engine runs the mic as its own independent pipeline (see
            // acquire-capture-source's module doc), so losing it must not
            // release camera/screen. Drop just this track and flag
            // `#micEnded`; `micState` reports 'ended' until a fresh
            // acquisition re-merges audio or the last source releases.
            stream.removeTrack(track);
            track.stop();
            this.#micEnded = true;
            this.dispatchEvent(new Event('capturestatechange'));
            return;
          }
          this.#releaseStream(kind);
          this.#setCaptureState(kind, 'ended');
          this.#consumeIntent(kind);
        },
        { once: true }
      );
    }
  }

  #reacquireCamera(): void {
    if (!this.#cameraActive) return;
    if (this.#cameraState !== 'active' && this.#cameraState !== 'acquiring') return;
    void this.#acquire('camera');
  }

  #reacquireMic(): void {
    if (!this.#micActive) return;
    if (!this.#micStream && !this.#micAcquiring) return;
    void this.#acquireMic();
  }

  async #refreshDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs: MediaCaptureDeviceInfo[] = [];
    for (const device of devices) {
      if (device.kind !== 'videoinput' && device.kind !== 'audioinput') continue;
      inputs.push({ deviceId: device.deviceId, kind: device.kind, label: device.label });
    }
    this.#captureDevices = inputs;
    this.dispatchEvent(new Event('capturedeviceschange'));
  }

  #setCaptureState(kind: MediaCaptureSourceKind, value: MediaCaptureState): void {
    if (kind === 'camera') {
      if (this.#cameraState === value) return;
      this.#cameraState = value;
    } else {
      if (this.#screenShareState === value) return;
      this.#screenShareState = value;
    }
    this.dispatchEvent(new Event('capturestatechange'));
  }

  // ── Preview internals ───────────────────────────────────────────────────

  /** Prefers the camera stream when both sources are live — no `previewSource` picker in this fake. */
  #syncPreview(): void {
    const preview = this.#preview;
    if (!preview) return;
    const stream = this.cameraStream ?? this.screenShareStream;
    if (!stream) {
      this.#clearPreview();
      return;
    }
    preview.srcObject = stream;
    preview.muted = true;
    preview.playsInline = true;
    preview.play().catch(() => undefined);
  }

  #clearPreview(): void {
    if (this.#preview?.srcObject) this.#preview.srcObject = null;
  }

  // ── Publish internals ───────────────────────────────────────────────────

  #setPublishState(value: MediaPublishSessionState): void {
    if (this.#publishState === value) return;
    this.#publishState = value;
    this.dispatchEvent(new Event('publishstatechange'));
  }

  #startStats(): void {
    let bytesSent = 0;
    let droppedFrames = 0;

    this.#statsTimer = setInterval(() => {
      // Source-aware per sample, so a mic-only session reports no video
      // traffic (the stats contract uses NaN for absent metrics) and a
      // video source joining mid-session starts counting.
      const hasVideo = this.cameraStream !== null || this.screenShareStream !== null;
      const hasAudio = this.micState === 'active';
      const videoBitrate = hasVideo ? FAKE_VIDEO_BITRATE * (0.92 + Math.random() * 0.16) : Number.NaN;
      const audioBitrate = hasAudio ? FAKE_AUDIO_BITRATE : Number.NaN;
      bytesSent += Math.round(((hasVideo ? videoBitrate : 0) + (hasAudio ? audioBitrate : 0)) / 8);
      if (hasVideo && Math.random() < 0.1) droppedFrames += 1;

      this.#publishStats = {
        encodedFps: hasVideo ? Math.round(29 + Math.random() * 2) : Number.NaN,
        videoBitrate,
        audioBitrate,
        droppedFrames,
        droppedGroups: 0,
        bytesSent,
        subscriberCount: Number.NaN,
      };
      this.dispatchEvent(new Event('publishstatsupdate'));
    }, STATS_INTERVAL_MS);
  }

  #stopStats(): void {
    if (this.#statsTimer === undefined) return;
    clearInterval(this.#statsTimer);
    this.#statsTimer = undefined;
  }

  #clearPublishTimer(): void {
    if (this.#publishTimer === undefined) return;
    clearTimeout(this.#publishTimer);
    this.#publishTimer = undefined;
  }
}
