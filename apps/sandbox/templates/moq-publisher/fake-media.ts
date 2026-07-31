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

  #captureSource: MediaCaptureSourceKind | null = null;
  #captureState: MediaCaptureState = 'idle';
  #stream: MediaStream | null = null;
  /** Bumped to cancel in-flight acquisitions when the source changes again. */
  #acquireToken = 0;

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
    this.#acquireToken++;
    this.#clearPublishTimer();
    this.#stopStats();
    this.#pendingPublish?.reject(new Error('The media host was destroyed.'));
    this.#pendingPublish = null;
    this.#releaseStream();
    super.destroy();
  }

  // ── MediaCaptureSourceCapability ────────────────────────────────────────

  get captureSource(): MediaCaptureSourceKind | null {
    return this.#captureSource;
  }

  set captureSource(value: MediaCaptureSourceKind | null) {
    const sameKind = value === this.#captureSource;
    // Re-setting the current kind re-acquires only after `denied`/`ended`.
    if (sameKind && (value === null || this.#captureState === 'acquiring' || this.#captureState === 'active')) return;

    this.#captureSource = value;
    if (!sameKind) this.dispatchEvent(new Event('capturesourcechange'));

    if (value === null) {
      this.#acquireToken++;
      this.#releaseStream();
      this.#setCaptureState('idle');
      if (this.#publishState === 'connecting' || this.#publishState === 'live') this.unpublish();
    } else {
      void this.#acquire(value);
    }
  }

  get captureState(): MediaCaptureState {
    return this.#captureState;
  }

  get captureStream(): MediaStream | null {
    return this.#captureState === 'active' ? this.#stream : null;
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
  }

  // ── MediaCaptureToggleCapability ────────────────────────────────────────

  get cameraMuted(): boolean {
    return this.#cameraMuted;
  }

  set cameraMuted(value: boolean) {
    if (value === this.#cameraMuted) return;
    this.#cameraMuted = value;
    for (const track of this.#stream?.getVideoTracks() ?? []) track.enabled = !value;
    this.dispatchEvent(new Event('capturetogglechange'));
  }

  get micMuted(): boolean {
    return this.#micMuted;
  }

  set micMuted(value: boolean) {
    if (value === this.#micMuted) return;
    this.#micMuted = value;
    for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !value;
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
    if (this.#captureState !== 'active') {
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
    const token = ++this.#acquireToken;
    this.#releaseStream();
    this.#setCaptureState('acquiring');

    try {
      const stream = kind === 'camera' ? await this.#getCameraStream() : await this.#getScreenStream();
      if (token !== this.#acquireToken) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.#adoptStream(stream);
      // Device labels stay redacted until a grant, so refresh after acquiring.
      void this.#refreshDevices();
    } catch (error) {
      if (token !== this.#acquireToken) return;
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.#setCaptureState(denied ? 'denied' : 'idle');
    }
  }

  async #getCameraStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: this.#videoInputDeviceId ? { deviceId: this.#videoInputDeviceId } : true,
      audio: this.#audioInputDeviceId ? { deviceId: this.#audioInputDeviceId } : true,
    });
  }

  async #getScreenStream(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (stream.getAudioTracks().length > 0) return stream;
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

  #adoptStream(stream: MediaStream): void {
    this.#stream = stream;
    for (const track of stream.getVideoTracks()) track.enabled = !this.#cameraMuted;
    for (const track of stream.getAudioTracks()) track.enabled = !this.#micMuted;
    this.#watchTracks(stream);
    this.#setCaptureState('active');
    this.dispatchEvent(new Event('capturestreamchange'));
    this.#syncPreview();
  }

  #releaseStream(): void {
    this.#clearPreview();
    const stream = this.#stream;
    if (!stream) return;
    this.#stream = null;
    for (const track of stream.getTracks()) track.stop();
    this.dispatchEvent(new Event('capturestreamchange'));
  }

  /** Ends outside our control (unplugged device, browser-UI "Stop sharing") land in `ended`. */
  #watchTracks(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          if (this.#stream !== stream) return;
          this.#releaseStream();
          this.#setCaptureState('ended');
          if (this.#publishState === 'connecting' || this.#publishState === 'live') this.unpublish();
        },
        { once: true }
      );
    }
  }

  #reacquireCamera(): void {
    if (this.#captureSource !== 'camera') return;
    if (this.#captureState !== 'active' && this.#captureState !== 'acquiring') return;
    void this.#acquire('camera');
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

  #setCaptureState(value: MediaCaptureState): void {
    if (this.#captureState === value) return;
    this.#captureState = value;
    this.dispatchEvent(new Event('capturestatechange'));
  }

  // ── Preview internals ───────────────────────────────────────────────────

  #syncPreview(): void {
    const preview = this.#preview;
    if (!preview || !this.#stream || this.#captureState !== 'active') return;
    preview.srcObject = this.#stream;
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
      const videoBitrate = FAKE_VIDEO_BITRATE * (0.92 + Math.random() * 0.16);
      const audioBitrate = FAKE_AUDIO_BITRATE;
      bytesSent += Math.round((videoBitrate + audioBitrate) / 8);
      if (Math.random() < 0.1) droppedFrames += 1;

      this.#publishStats = {
        encodedFps: Math.round(29 + Math.random() * 2),
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
