import type { MediaCaptureDevicesState } from '@videojs/media';
import { isMediaCaptureDevicesCapable } from '@videojs/media';
import { listen } from '@videojs/utils/dom';
import { definePlayerFeature } from '../../feature';

export const captureDevicesFeature = definePlayerFeature({
  name: 'captureDevices',
  state: ({ target }): MediaCaptureDevicesState => ({
    cameras: [],
    microphones: [],
    selectedCameraId: '',
    selectedMicrophoneId: '',

    selectCamera(deviceId) {
      const { media } = target();
      if (!isMediaCaptureDevicesCapable(media)) return;
      media.videoInputDeviceId = deviceId;
    },

    selectMicrophone(deviceId) {
      const { media } = target();
      if (!isMediaCaptureDevicesCapable(media)) return;
      media.audioInputDeviceId = deviceId;
    },
  }),

  attach({ target, signal, set }) {
    const { media } = target;

    if (!isMediaCaptureDevicesCapable(media)) return;

    // Selections have no dedicated change event, so re-sync them alongside
    // the device list on `capturedeviceschange`.
    const sync = () =>
      set({
        cameras: media.captureDevices.filter((device) => device.kind === 'videoinput'),
        microphones: media.captureDevices.filter((device) => device.kind === 'audioinput'),
        selectedCameraId: media.videoInputDeviceId,
        selectedMicrophoneId: media.audioInputDeviceId,
      });

    sync();

    listen(media, 'capturedeviceschange', sync, { signal });
  },
});
