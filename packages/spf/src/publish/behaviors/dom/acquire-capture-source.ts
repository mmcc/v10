/**
 * **Own the capture stream for camera, screen share, and the microphone —
 * three independent pipelines, not one exclusive selection.** Each of
 * `acquireCameraSource` / `acquireScreenShare` / `acquireMicrophone` is a
 * single-positive-state reactor (`'inactive'` ↔ `'active'`) following
 * `setup-mediasource`'s machine-reactor idiom, sharing the acquire/release
 * mechanics in {@link runCaptureAcquisition} but each owning its own
 * state/context slots so starting a share never touches the camera and a
 * mic device change never touches either video source.
 *
 * - **Camera**: `getUserMedia({video, audio: false})`, gated on
 *   `state.cameraActive`, re-acquiring on a `state.videoInputDeviceId`
 *   change.
 * - **Screen**: `getDisplayMedia({video: true, audio: false})` — system
 *   audio is never requested (see the multi-source design record's
 *   "System audio" decision) — gated on `state.screenShareActive`.
 * - **Microphone**: `getUserMedia({audio, video: false})`, gated on
 *   *either* video source being active (so the permission prompt still
 *   waits for real capture intent, matching v1's UX) but keyed for
 *   re-acquisition on `state.audioInputDeviceId` ALONE — never on which
 *   video source is active. This is the actual fix for the confirmed
 *   defect: a mic device change used to no-op while screen-sharing
 *   because the mic was merged into the screen's stream; now it has no
 *   dependency on the video pipelines at all.
 *
 * **Intent consumption** (multi-writer contract on `cameraActive` /
 * `screenShareActive`): the adapter writes these slots to record consumer
 * intent; the video acquire behaviors are their second writer, consuming
 * the intent (writing `false`) when the pipeline terminates without
 * consumer action — permission `denied`, the track `ended` outside our
 * control, or any acquisition failure (surfaced as a capture
 * `publishError`). The slot therefore always means "a request being served", so
 * the mic's OR-gate collapses when nothing is really capturing (no hot
 * mic behind a dismissed screen picker) and the next `true` write is a
 * real rising edge — one-click retry after a denial. The terminal status
 * (`denied`/`ended`) survives the release so UIs keep their blocked/ended
 * messaging.
 *
 * **Microphone failure policy**: a machine without a (satisfiable) mic
 * publishes video-only — missing-device failures land a quiet `idle`
 * with no `publishError`, and an exact `audioInputDeviceId` that can no
 * longer be honored falls back to the platform default. A mic parked in
 * `ended` (unplugged mid-capture) or that quiet `idle` re-acquires on
 * the next `devicechange` while the gate is still active.
 *
 * The acquire work lives in each reactor's positive-state `effects:` (not
 * `entry`) so cleanup fires on BOTH state exit AND a within-state identity
 * change (kind-specific device id, or the mic's OR'd gate rising edge).
 * Stale-async guard: the effect-run closure carries a `stale` flag flipped
 * by its own cleanup — an acquire that resolves after the gate changed (or
 * capture was released) stops its tracks and discards without touching
 * the slots. This is the per-run generation/token pattern.
 */
import { listen } from '@videojs/utils/dom';
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import type { ReadonlySignal, Signal } from '../../../core/signals/primitives';
import { peek, signal } from '../../../core/signals/primitives';

/** Which kind of video feeds capture. Additive — both may be active at once. */
export type CaptureSourceKind = 'camera' | 'screen';

/** Lifecycle of one capture pipeline. */
export type CaptureStatus = 'idle' | 'acquiring' | 'active' | 'denied' | 'ended';

/** Settings snapshot of one acquired capture track. */
export interface CaptureTrackFacts {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
}

/** A publish-pipeline failure surfaced as engine state. */
export interface PublishErrorFacts {
  code: 'capture' | 'encode' | 'transport' | 'protocol';
  message: string;
  cause?: unknown;
}

function exactDeviceConstraint(deviceId: string | undefined): MediaTrackConstraints | boolean {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function isNotAllowedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

/**
 * getUserMedia failures a missing/unsatisfiable device produces:
 * NotFoundError (no such device at all) and OverconstrainedError (an
 * `exact` deviceId that cannot be honored). Name-checked rather than
 * instanceof — OverconstrainedError is its own constructor in some
 * engines.
 */
function isMissingDeviceError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

function snapshotVideoTrack(stream: MediaStream): CaptureTrackFacts | undefined {
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  const settings = track.getSettings();
  return { deviceId: settings.deviceId, width: settings.width, height: settings.height, frameRate: settings.frameRate };
}

function snapshotAudioTrack(stream: MediaStream): CaptureTrackFacts | undefined {
  const track = stream.getAudioTracks()[0];
  if (!track) return undefined;
  const settings = track.getSettings();
  return { deviceId: settings.deviceId, sampleRate: settings.sampleRate, channelCount: settings.channelCount };
}

/**
 * Shared acquire/release mechanics for one capture pipeline. `acquire`
 * resolves the platform stream; `snapshot` projects it to track facts.
 * Everything else — the stale-async guard, track-ended listeners, and
 * cleanup — is identical across camera, screen, and mic.
 */
function runCaptureAcquisition({
  acquire,
  snapshot,
  status,
  tracks,
  stream,
  publishError,
  intent,
  tolerateMissingDevice,
}: {
  acquire: () => Promise<MediaStream>;
  snapshot: (stream: MediaStream) => CaptureTrackFacts | undefined;
  status: Signal<CaptureStatus | undefined>;
  tracks: Signal<CaptureTrackFacts | undefined>;
  stream: Signal<MediaStream | undefined>;
  publishError: Signal<PublishErrorFacts | undefined>;
  /**
   * Consumer-intent slot this pipeline serves, consumed (set `false`) when
   * it terminates without consumer action — `denied`, `ended`, or any
   * acquisition failure — see the module doc's multi-writer contract. The
   * mic passes none: its gate is the video sources' intent, not its own.
   */
  intent?: Signal<boolean | undefined>;
  /** Mic-only policy: a missing/unsatisfiable device lands a quiet `idle` instead of a capture error. */
  tolerateMissingDevice?: boolean;
}): () => void {
  let owned: MediaStream | undefined;
  let stale = false;
  const trackCleanups: (() => void)[] = [];

  const release = () => {
    for (const dispose of trackCleanups) dispose();
    trackCleanups.length = 0;
    if (!owned) return;
    for (const track of owned.getTracks()) track.stop();
    owned = undefined;
    stream.set(undefined);
    tracks.set(undefined);
  };

  const onTrackEnded = () => {
    release();
    status.set('ended');
    intent?.set(false);
  };

  const run = async () => {
    let acquired: MediaStream;
    try {
      acquired = await acquire();
    } catch (error) {
      if (stale) return;
      if (isNotAllowedError(error)) {
        status.set('denied');
        intent?.set(false);
        return;
      }
      if (tolerateMissingDevice && isMissingDeviceError(error)) {
        // No (satisfiable) device is not a publish failure — capture goes
        // on without this pipeline (`tracks` simply stays unset), matching
        // the old fused model's guarantee that a missing microphone never
        // kills a video-only publish.
        status.set('idle');
        return;
      }
      status.set('idle');
      publishError.set({
        code: 'capture',
        message: error instanceof Error ? error.message : 'Failed to acquire a capture source.',
        cause: error,
      });
      // Any terminal acquisition failure consumes the intent, not just a
      // denial — a NotReadable/NotFound camera would otherwise hold the
      // mic's OR-gate hot and block the one-click retry exactly like the
      // denied path did (codex review).
      intent?.set(false);
      return;
    }
    if (stale) {
      for (const track of acquired.getTracks()) track.stop();
      return;
    }
    owned = acquired;
    for (const track of acquired.getTracks()) {
      trackCleanups.push(listen(track, 'ended', onTrackEnded, { once: true }));
    }
    stream.set(acquired);
    tracks.set(snapshot(acquired));
    status.set('active');
  };

  status.set('acquiring');
  // A fresh attempt supersedes any stale capture failure: the slot is
  // shared by three pipelines, so per-source blame isn't expressible —
  // but an in-flight acquisition either succeeds (error gone is right)
  // or re-writes its own failure below. Other codes are never touched.
  if (peek(publishError)?.code === 'capture') publishError.set(undefined);
  void run();

  return () => {
    stale = true;
    release();
    // A pipeline that terminated on its own keeps its terminal status
    // through the release triggered by its consumed intent — 'denied' /
    // 'ended' are the UI's evidence for blocked/ended messaging. Only an
    // in-flight or active pipeline resets to 'idle'; the next acquisition
    // overwrites either way with 'acquiring'.
    const settled = peek(status);
    if (settled !== 'denied' && settled !== 'ended') status.set('idle');
  };
}

type CaptureFsmState = 'inactive' | 'active';

// ----------------------------------------
// Camera
// ----------------------------------------

export interface AcquireCameraSourceState {
  cameraActive?: boolean;
  videoInputDeviceId?: string;
  cameraState?: CaptureStatus;
  cameraTracks?: CaptureTrackFacts;
  publishError?: PublishErrorFacts | undefined;
}

export interface AcquireCameraSourceContext {
  cameraStream?: MediaStream | undefined;
}

async function acquireCamera(videoInputDeviceId: string | undefined): Promise<MediaStream> {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error('Media capture is not available in this environment (no navigator.mediaDevices).');
  }
  return mediaDevices.getUserMedia({ video: exactDeviceConstraint(videoInputDeviceId), audio: false });
}

function acquireCameraSourceSetup({
  state,
  context,
}: {
  state: {
    // Intent slot: adapter-written, consumed (set `false`) here on
    // `denied`/`ended` — see the module doc's multi-writer contract.
    cameraActive: Signal<AcquireCameraSourceState['cameraActive']>;
    videoInputDeviceId: ReadonlySignal<AcquireCameraSourceState['videoInputDeviceId']>;
    cameraState: Signal<AcquireCameraSourceState['cameraState']>;
    cameraTracks: Signal<AcquireCameraSourceState['cameraTracks']>;
    publishError: Signal<AcquireCameraSourceState['publishError']>;
  };
  context: {
    cameraStream: Signal<AcquireCameraSourceContext['cameraStream']>;
  };
}): Reactor<CaptureFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<CaptureFsmState>({
    initial: 'inactive',
    monitor: () => (state.cameraActive.get() ? 'active' : 'inactive'),
    states: {
      inactive: {},
      active: {
        // effects (not entry) so a videoInputDeviceId change re-fires
        // through the cleanup below in addition to state exit / destroy.
        effects: () => {
          const deviceId = state.videoInputDeviceId.get();
          return runCaptureAcquisition({
            acquire: () => acquireCamera(deviceId),
            snapshot: snapshotVideoTrack,
            status: state.cameraState,
            tracks: state.cameraTracks,
            stream: context.cameraStream,
            publishError: state.publishError,
            intent: state.cameraActive,
          });
        },
      },
    },
  });
}

export const acquireCameraSource = defineBehavior({
  stateKeys: ['cameraActive', 'videoInputDeviceId', 'cameraState', 'cameraTracks', 'publishError'],
  contextKeys: ['cameraStream'],
  setup: acquireCameraSourceSetup,
});

// ----------------------------------------
// Screen share
// ----------------------------------------

export interface AcquireScreenShareState {
  screenShareActive?: boolean;
  screenShareState?: CaptureStatus;
  screenTracks?: CaptureTrackFacts;
  publishError?: PublishErrorFacts | undefined;
}

export interface AcquireScreenShareContext {
  screenStream?: MediaStream | undefined;
}

async function acquireScreen(): Promise<MediaStream> {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is not available in this environment (no navigator.mediaDevices).');
  }
  // System/tab audio is never requested — see the multi-source design
  // record's "System audio" decision. A screen-audio track is future work.
  const stream = await mediaDevices.getDisplayMedia({ video: true, audio: false });
  // Screen content favors legibility over motion smoothness; the hint
  // steers browser scaling/encoding heuristics (design record, "Encoder
  // budget & degradation" decision).
  for (const track of stream.getVideoTracks()) track.contentHint = 'detail';
  return stream;
}

function acquireScreenShareSetup({
  state,
  context,
}: {
  state: {
    // Intent slot: adapter-written, consumed (set `false`) here on
    // `denied` (picker dismissed) / `ended` (browser-native "Stop
    // sharing") — see the module doc's multi-writer contract.
    screenShareActive: Signal<AcquireScreenShareState['screenShareActive']>;
    screenShareState: Signal<AcquireScreenShareState['screenShareState']>;
    screenTracks: Signal<AcquireScreenShareState['screenTracks']>;
    publishError: Signal<AcquireScreenShareState['publishError']>;
  };
  context: {
    screenStream: Signal<AcquireScreenShareContext['screenStream']>;
  };
}): Reactor<CaptureFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<CaptureFsmState>({
    initial: 'inactive',
    monitor: () => (state.screenShareActive.get() ? 'active' : 'inactive'),
    states: {
      inactive: {},
      active: {
        effects: () =>
          runCaptureAcquisition({
            acquire: acquireScreen,
            snapshot: snapshotVideoTrack,
            status: state.screenShareState,
            tracks: state.screenTracks,
            stream: context.screenStream,
            publishError: state.publishError,
            intent: state.screenShareActive,
          }),
      },
    },
  });
}

export const acquireScreenShare = defineBehavior({
  stateKeys: ['screenShareActive', 'screenShareState', 'screenTracks', 'publishError'],
  contextKeys: ['screenStream'],
  setup: acquireScreenShareSetup,
});

// ----------------------------------------
// Microphone
// ----------------------------------------

export interface AcquireMicrophoneState {
  cameraActive?: boolean;
  screenShareActive?: boolean;
  audioInputDeviceId?: string;
  micState?: CaptureStatus;
  micTracks?: CaptureTrackFacts;
  publishError?: PublishErrorFacts | undefined;
}

export interface AcquireMicrophoneContext {
  micStream?: MediaStream | undefined;
}

async function acquireMic(audioInputDeviceId: string | undefined): Promise<MediaStream> {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error('Media capture is not available in this environment (no navigator.mediaDevices).');
  }
  try {
    return await mediaDevices.getUserMedia({ audio: exactDeviceConstraint(audioInputDeviceId), video: false });
  } catch (error) {
    // A persisted device id whose mic is gone must degrade to the platform
    // default rather than lose audio — retry unconstrained once; anything
    // else propagates to the shared failure policy.
    if (audioInputDeviceId && isMissingDeviceError(error)) {
      return mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw error;
  }
}

function acquireMicrophoneSetup({
  state,
  context,
}: {
  state: {
    cameraActive: ReadonlySignal<AcquireMicrophoneState['cameraActive']>;
    screenShareActive: ReadonlySignal<AcquireMicrophoneState['screenShareActive']>;
    audioInputDeviceId: ReadonlySignal<AcquireMicrophoneState['audioInputDeviceId']>;
    micState: Signal<AcquireMicrophoneState['micState']>;
    micTracks: Signal<AcquireMicrophoneState['micTracks']>;
    publishError: Signal<AcquireMicrophoneState['publishError']>;
  };
  context: {
    micStream: Signal<AcquireMicrophoneContext['micStream']>;
  };
}): Reactor<CaptureFsmState | 'destroying' | 'destroyed'> {
  // Bumped by the devicechange listener below to re-fire acquisition —
  // internal to this reactor, never a composition slot.
  const retryEpoch = signal(0);
  return createMachineReactor<CaptureFsmState>({
    initial: 'inactive',
    // Gated on either video source wanting to capture at all (keeps the
    // permission prompt tied to real capture intent), but the effect below
    // tracks ONLY audioInputDeviceId — switching camera<->screen while
    // either stays active must never re-fire this pipeline. Because the
    // video behaviors consume their intent on `denied`/`ended`, this gate
    // collapses when nothing is really capturing — the mic never outlives
    // a dismissed picker or a browser-native "Stop sharing".
    monitor: () => (state.cameraActive.get() || state.screenShareActive.get() ? 'active' : 'inactive'),
    states: {
      inactive: {},
      active: {
        // Replug recovery. The acquisition effect below deliberately does
        // NOT track the device list (plugging in a webcam must not restart
        // a healthy mic), so a mic parked in 'ended' (unplugged) or the
        // quiet missing-device 'idle' would stay dead forever. Instead the
        // devicechange listener nudges the epoch only from those two
        // parked statuses — never while acquiring/active/denied.
        entry: () => {
          const mediaDevices = globalThis.navigator?.mediaDevices;
          if (!mediaDevices?.addEventListener) return;
          return listen(mediaDevices, 'devicechange', () => {
            const parked = peek(state.micState);
            if (parked === 'ended' || parked === 'idle') retryEpoch.set(peek(retryEpoch) + 1);
          });
        },
        effects: () => {
          const deviceId = state.audioInputDeviceId.get();
          retryEpoch.get();
          return runCaptureAcquisition({
            acquire: () => acquireMic(deviceId),
            snapshot: snapshotAudioTrack,
            status: state.micState,
            tracks: state.micTracks,
            stream: context.micStream,
            publishError: state.publishError,
            tolerateMissingDevice: true,
          });
        },
      },
    },
  });
}

export const acquireMicrophone = defineBehavior({
  stateKeys: ['cameraActive', 'screenShareActive', 'audioInputDeviceId', 'micState', 'micTracks', 'publishError'],
  contextKeys: ['micStream'],
  setup: acquireMicrophoneSetup,
});
