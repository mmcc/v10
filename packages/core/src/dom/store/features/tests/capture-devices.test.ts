import type { MediaCaptureDeviceInfo } from '@videojs/media';
import { createStore } from '@videojs/store';
import { describe, expect, it } from 'vite-plus/test';

import type { PlayerTarget } from '../../../player';
import { createMockVideo } from '../../../tests/test-helpers';
import { captureDevicesFeature } from '../capture-devices';

interface CaptureDevicesCapableMedia extends EventTarget {
  captureDevices: readonly MediaCaptureDeviceInfo[];
  videoInputDeviceId: string;
  audioInputDeviceId: string;
}

const CAMERA_A: MediaCaptureDeviceInfo = { deviceId: 'cam-a', kind: 'videoinput', label: 'Camera A' };
const CAMERA_B: MediaCaptureDeviceInfo = { deviceId: 'cam-b', kind: 'videoinput', label: 'Camera B' };
const MIC_A: MediaCaptureDeviceInfo = { deviceId: 'mic-a', kind: 'audioinput', label: 'Microphone A' };

function createDevicesMedia(initial: Partial<CaptureDevicesCapableMedia> = {}): CaptureDevicesCapableMedia {
  const media = new EventTarget() as CaptureDevicesCapableMedia;

  media.captureDevices = initial.captureDevices ?? [];
  media.videoInputDeviceId = initial.videoInputDeviceId ?? '';
  media.audioInputDeviceId = initial.audioInputDeviceId ?? '';
  return media;
}

describe('captureDevicesFeature', () => {
  describe('fallback (media without capture-devices capability)', () => {
    it('stays at defaults when the media is not capture-devices capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: video, container: null });

      expect(store.state.cameras).toEqual([]);
      expect(store.state.microphones).toEqual([]);
      expect(store.state.selectedCameraId).toBe('');
      expect(store.state.selectedMicrophoneId).toBe('');
    });

    it('no-ops actions when the media is not capture-devices capable', () => {
      const video = createMockVideo();

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: video, container: null });

      expect(() => store.selectCamera('cam-a')).not.toThrow();
      expect(() => store.selectMicrophone('mic-a')).not.toThrow();
    });
  });

  describe('capable media', () => {
    it('splits the flat device list by kind on attach', () => {
      const media = createDevicesMedia({
        captureDevices: [CAMERA_A, MIC_A, CAMERA_B],
        videoInputDeviceId: 'cam-a',
        audioInputDeviceId: 'mic-a',
      });

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      expect(store.state.cameras).toEqual([CAMERA_A, CAMERA_B]);
      expect(store.state.microphones).toEqual([MIC_A]);
      expect(store.state.selectedCameraId).toBe('cam-a');
      expect(store.state.selectedMicrophoneId).toBe('mic-a');
    });

    it('re-reads devices and selections on `capturedeviceschange`', () => {
      const media = createDevicesMedia({ captureDevices: [CAMERA_A] });

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      media.captureDevices = [CAMERA_A, CAMERA_B, MIC_A];
      media.videoInputDeviceId = 'cam-b';
      media.audioInputDeviceId = 'mic-a';
      media.dispatchEvent(new Event('capturedeviceschange'));

      expect(store.state.cameras).toEqual([CAMERA_A, CAMERA_B]);
      expect(store.state.microphones).toEqual([MIC_A]);
      expect(store.state.selectedCameraId).toBe('cam-b');
      expect(store.state.selectedMicrophoneId).toBe('mic-a');
    });

    it('`selectCamera()` writes the media video input device id', () => {
      const media = createDevicesMedia({ captureDevices: [CAMERA_A, CAMERA_B] });

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.selectCamera('cam-b');

      expect(media.videoInputDeviceId).toBe('cam-b');
    });

    it('`selectMicrophone()` writes the media audio input device id', () => {
      const media = createDevicesMedia({ captureDevices: [MIC_A] });

      const store = createStore<PlayerTarget>()(captureDevicesFeature);

      store.attach({ media: media as unknown as PlayerTarget['media'], container: null });

      store.selectMicrophone('mic-a');

      expect(media.audioInputDeviceId).toBe('mic-a');
    });
  });
});
