/**
 * **Keep `state.captureDevices` synced with the platform's capture
 * inputs.** On setup (when `navigator.mediaDevices` exists) enumerates
 * `videoinput`/`audioinput` devices into the slot, then re-enumerates on
 * the platform `devicechange` event and whenever any capture pipeline's
 * status becomes `'active'` — device labels stay redacted until a capture
 * grant, so the post-grant refresh is what surfaces human-readable names
 * (a camera grant reveals video-input labels, a mic grant reveals
 * audio-input ones; screen share never gates an input-device permission,
 * so it's excluded).
 *
 * Simple behavior: one platform listener plus one effect watching both
 * capture statuses. Each refresh writes a fresh array (a new enumeration
 * snapshot), even when the contents are unchanged. In-flight enumerations
 * that resolve after cleanup — or after a newer refresh started — are
 * discarded, so a slow older snapshot can never overwrite a newer one.
 *
 * Sole writer of `state.captureDevices`.
 */
import { listen } from '@videojs/utils/dom';
import { defineBehavior } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import type { ReadonlySignal, Signal } from '../../../core/signals/primitives';
import type { CaptureStatus } from './acquire-capture-source';

/** One selectable capture input device (an `enumerateDevices` snapshot). */
export interface CaptureDeviceFacts {
  deviceId: string;
  kind: 'videoinput' | 'audioinput';
  /** Empty until the user grants device permission. */
  label: string;
}

/**
 * State shape for capture-device enumeration.
 */
export interface EnumerateCaptureDevicesState {
  captureDevices?: CaptureDeviceFacts[];
  cameraState?: CaptureStatus;
  micState?: CaptureStatus;
}

function isCaptureInputKind(kind: MediaDeviceKind): kind is 'videoinput' | 'audioinput' {
  return kind === 'videoinput' || kind === 'audioinput';
}

function enumerateCaptureDevicesSetup({
  state,
}: {
  state: {
    captureDevices: Signal<EnumerateCaptureDevicesState['captureDevices']>;
    cameraState: ReadonlySignal<EnumerateCaptureDevicesState['cameraState']>;
    micState: ReadonlySignal<EnumerateCaptureDevicesState['micState']>;
  };
}): (() => void) | undefined {
  const mediaDevices = globalThis.navigator?.mediaDevices;
  if (!mediaDevices?.enumerateDevices) return undefined;

  let disposed = false;
  let generation = 0;
  const refresh = async () => {
    // devicechange and the post-grant status refresh can overlap; only the
    // newest enumeration may commit, whatever order the platform resolves.
    const ticket = ++generation;
    const devices = await mediaDevices.enumerateDevices();
    if (disposed || ticket !== generation) return;
    const inputs: CaptureDeviceFacts[] = [];
    for (const { deviceId, kind, label } of devices) {
      if (isCaptureInputKind(kind)) inputs.push({ deviceId, kind, label });
    }
    state.captureDevices.set(inputs);
  };

  void refresh();
  const removeDeviceChange = listen(mediaDevices, 'devicechange', () => void refresh());
  // Labels appear once capture is granted — refresh when either the
  // camera or the mic goes active (each reveals a different input kind).
  const cleanupStatus = effect(() => {
    if (state.cameraState.get() !== 'active' && state.micState.get() !== 'active') return;
    void refresh();
  });

  return () => {
    disposed = true;
    removeDeviceChange();
    cleanupStatus();
  };
}

export const enumerateCaptureDevices = defineBehavior({
  stateKeys: ['captureDevices', 'cameraState', 'micState'],
  contextKeys: [],
  setup: enumerateCaptureDevicesSetup,
});
