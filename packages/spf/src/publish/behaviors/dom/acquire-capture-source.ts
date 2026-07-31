/**
 * **Own the capture stream for the selected capture source.** While a
 * `state.captureSource` selection is present, acquires the matching
 * platform stream (`getUserMedia` for camera, `getDisplayMedia` + mic
 * merge for screen), publishes it on `context.captureStream`, snapshots
 * track settings into `state.captureTracks`, and drives
 * `state.captureStatus` through `acquiring → active` (or `denied` /
 * `idle`-with-`publishError` on failure, `ended` when the platform stops
 * the tracks). Clearing the selection — or any selection-identity change —
 * stops the owned tracks and clears the slots.
 *
 * Single-positive-state reactor (`'no-source'` ↔ `'source-selected'`)
 * following `setup-mediasource`'s machine-reactor idiom. The acquire work
 * lives in the positive state's `effects:` (not `entry`) so the cleanup
 * fires on BOTH state exit AND within-state selection-identity changes:
 * each distinct `state.captureSource` write (kind or device-id change —
 * the adapter always writes a fresh selection object) re-fires the effect
 * through its cleanup, giving stop-old → acquire-new structurally.
 *
 * Stale-async guard: the effect-run closure carries a `stale` flag flipped
 * by its own cleanup — an acquire that resolves after the selection
 * changed (or capture was released) stops its tracks and discards without
 * touching the slots. This is the per-run generation/token pattern.
 *
 * Sole writer of `context.captureStream`, `state.captureStatus`, and
 * `state.captureTracks`; co-writer of `state.publishError` (capture
 * failures only — encode/transport writers land in M2/M3).
 */
import { listen } from '@videojs/utils/dom';
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import type { ReadonlySignal, Signal } from '../../../core/signals/primitives';

/** Which kind of media source feeds capture. */
export type CaptureSourceKind = 'camera' | 'screen';

/**
 * Consumer intent describing what to capture. Device ids apply to camera
 * capture; screen capture is picker-driven by the platform (the
 * `audioDeviceId` still selects the microphone merged into an audio-less
 * display stream). Every distinct selection object written to
 * `state.captureSource` is an acquire intent — writers re-acquire by
 * writing a fresh object even when the fields are unchanged.
 */
export interface CaptureSourceSelection {
  kind: CaptureSourceKind;
  videoDeviceId?: string;
  audioDeviceId?: string;
}

/** Lifecycle of the local capture pipeline. */
export type CaptureStatus = 'idle' | 'acquiring' | 'active' | 'denied' | 'ended';

/** Settings snapshot of an acquired capture track. */
export interface CaptureTrackFacts {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  sampleRate?: number;
  channelCount?: number;
}

/** Per-kind settings snapshots of the acquired capture tracks. */
export interface CaptureTracksFacts {
  video?: CaptureTrackFacts;
  audio?: CaptureTrackFacts;
}

/** A publish-pipeline failure surfaced as engine state. */
export interface PublishErrorFacts {
  code: 'capture' | 'encode' | 'transport' | 'protocol';
  message: string;
  cause?: unknown;
}

/**
 * State shape for capture-source acquisition.
 */
export interface AcquireCaptureSourceState {
  captureSource?: CaptureSourceSelection | undefined;
  captureStatus?: CaptureStatus;
  captureTracks?: CaptureTracksFacts;
  publishError?: PublishErrorFacts | undefined;
}

/**
 * Context shape for capture-source acquisition.
 */
export interface AcquireCaptureSourceContext {
  captureStream?: MediaStream | undefined;
}

type AcquireCaptureSourceFsmState = 'no-source' | 'source-selected';

function exactDeviceConstraint(deviceId: string | undefined): MediaTrackConstraints | boolean {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

/**
 * getUserMedia failures a missing/unsatisfiable audio input produces:
 * NotFoundError (mic-less machine) and OverconstrainedError (the exact
 * audio deviceId cannot be honored). Either name can also mean the VIDEO
 * side failed — the video-only retry re-raises in that case, so treating
 * them as retryable stays safe.
 */
function isMissingDeviceError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

/**
 * Acquire the platform stream for a selection. A missing/unsatisfiable
 * microphone must not kill capture on either path: camera acquisition
 * retries video-only when the combined request fails on a device error,
 * and screen shares that come back without an audio track get a mic-only
 * `getUserMedia` stream merged in with the merge failure swallowed
 * (video-only share). `captureTracks` then simply lacks audio.
 */
async function acquireSelection(selection: CaptureSourceSelection): Promise<MediaStream> {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error('Media capture is not available in this environment (no navigator.mediaDevices).');
  }
  if (selection.kind === 'camera') {
    const video = exactDeviceConstraint(selection.videoDeviceId);
    try {
      return await mediaDevices.getUserMedia({ video, audio: exactDeviceConstraint(selection.audioDeviceId) });
    } catch (error) {
      if (!isMissingDeviceError(error)) throw error;
      // Mirror the screen path's mic tolerance: retry video-only. If the
      // video side was the real offender the retry fails the same way and
      // that error propagates.
      return mediaDevices.getUserMedia({ video, audio: false });
    }
  }
  const stream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
  if (stream.getAudioTracks().length > 0) return stream;
  try {
    const mic = await mediaDevices.getUserMedia({ audio: exactDeviceConstraint(selection.audioDeviceId) });
    for (const track of mic.getAudioTracks()) stream.addTrack(track);
  } catch {
    // No microphone → publish the screen share video-only.
  }
  return stream;
}

function snapshotTracks(stream: MediaStream): CaptureTracksFacts {
  const facts: CaptureTracksFacts = {};
  const video = stream.getVideoTracks()[0];
  if (video) {
    const settings = video.getSettings();
    facts.video = {
      deviceId: settings.deviceId,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
    };
  }
  const audio = stream.getAudioTracks()[0];
  if (audio) {
    const settings = audio.getSettings();
    facts.audio = {
      deviceId: settings.deviceId,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
    };
  }
  return facts;
}

function isNotAllowedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotAllowedError';
}

function acquireCaptureSourceSetup({
  state,
  context,
}: {
  state: {
    captureSource: ReadonlySignal<AcquireCaptureSourceState['captureSource']>;
    captureStatus: Signal<AcquireCaptureSourceState['captureStatus']>;
    captureTracks: Signal<AcquireCaptureSourceState['captureTracks']>;
    publishError: Signal<AcquireCaptureSourceState['publishError']>;
  };
  context: {
    captureStream: Signal<AcquireCaptureSourceContext['captureStream']>;
  };
}): Reactor<AcquireCaptureSourceFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<AcquireCaptureSourceFsmState>({
    initial: 'no-source',
    // Single direct signal read — inline monitor per the reactor convention.
    monitor: () => (state.captureSource.get() ? 'source-selected' : 'no-source'),
    states: {
      'no-source': {},

      'source-selected': {
        // effects (not entry) so within-state selection-identity changes
        // (fresh selection object with a new kind or device id) re-fire
        // through the cleanup below in addition to state exit / destroy.
        effects: () => {
          // Tracked: the selection object's identity drives re-acquisition.
          const selection = state.captureSource.get()!;

          // Owned per effect run; `stale` is the generation token — flipped
          // by this run's cleanup, checked after every await.
          let stream: MediaStream | undefined;
          let stale = false;
          const trackCleanups: (() => void)[] = [];

          const release = () => {
            for (const dispose of trackCleanups) dispose();
            trackCleanups.length = 0;
            if (!stream) return;
            for (const track of stream.getTracks()) track.stop();
            stream = undefined;
            context.captureStream.set(undefined);
            state.captureTracks.set(undefined);
          };

          // Track ends outside our control (device unplugged, browser-UI
          // "Stop sharing") release the stream and land in `'ended'`.
          // `track.stop()` never fires `'ended'`, so our own release paths
          // don't loop through here.
          const onTrackEnded = () => {
            release();
            state.captureStatus.set('ended');
          };

          const acquire = async () => {
            let acquired: MediaStream;
            try {
              acquired = await acquireSelection(selection);
            } catch (error) {
              if (stale) return;
              if (isNotAllowedError(error)) {
                state.captureStatus.set('denied');
                return;
              }
              state.captureStatus.set('idle');
              state.publishError.set({
                code: 'capture',
                message: error instanceof Error ? error.message : 'Failed to acquire the capture source.',
                cause: error,
              });
              return;
            }
            if (stale) {
              // The selection changed while the prompt/acquisition was in
              // flight — a newer run owns the slots now; discard.
              for (const track of acquired.getTracks()) track.stop();
              return;
            }
            stream = acquired;
            for (const track of acquired.getTracks()) {
              trackCleanups.push(listen(track, 'ended', onTrackEnded, { once: true }));
            }
            context.captureStream.set(acquired);
            state.captureTracks.set(snapshotTracks(acquired));
            state.captureStatus.set('active');
          };

          state.captureStatus.set('acquiring');
          void acquire();

          return () => {
            stale = true;
            release();
            state.captureStatus.set('idle');
          };
        },
      },
    },
  });
}

export const acquireCaptureSource = defineBehavior({
  stateKeys: ['captureSource', 'captureStatus', 'captureTracks', 'publishError'],
  contextKeys: ['captureStream'],
  setup: acquireCaptureSourceSetup,
});
