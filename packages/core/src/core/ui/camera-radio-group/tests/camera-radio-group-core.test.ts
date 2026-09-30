import type { MediaCaptureDevicesState } from '@videojs/media';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { CameraRadioGroupState } from '../camera-radio-group-core';
import { CameraRadioGroupCore } from '../camera-radio-group-core';

function createMediaState(overrides: Partial<MediaCaptureDevicesState> = {}): MediaCaptureDevicesState {
  return {
    cameras: [
      { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD Camera' },
      { deviceId: 'cam-2', kind: 'videoinput', label: 'External Webcam' },
    ],
    microphones: [],
    selectedCameraId: 'cam-1',
    selectedMicrophoneId: '',
    selectCamera: vi.fn(),
    selectMicrophone: vi.fn(),
    ...overrides,
  };
}

function createState(overrides: Partial<CameraRadioGroupState> = {}): CameraRadioGroupState {
  return {
    devices: [
      { value: 'cam-1', label: 'FaceTime HD Camera' },
      { value: 'cam-2', label: 'External Webcam' },
    ],
    value: 'cam-1',
    disabled: false,
    availability: 'available',
    label: '',
    ...overrides,
  };
}

describe('CameraRadioGroupCore', () => {
  describe('getState', () => {
    it('projects cameras', () => {
      const core = new CameraRadioGroupCore();

      core.setMedia(createMediaState());

      const state = core.getState();

      expect(state.devices).toEqual([
        { value: 'cam-1', label: 'FaceTime HD Camera' },
        { value: 'cam-2', label: 'External Webcam' },
      ]);
      expect(state.value).toBe('cam-1');
    });

    it('falls back to numbered labels when device labels are empty', () => {
      const core = new CameraRadioGroupCore();

      core.setMedia(
        createMediaState({
          cameras: [
            { deviceId: 'cam-1', kind: 'videoinput', label: '' },
            { deviceId: 'cam-2', kind: 'videoinput', label: '' },
          ],
        })
      );

      expect(core.getState().devices).toEqual([
        { value: 'cam-1', label: 'Camera 1' },
        { value: 'cam-2', label: 'Camera 2' },
      ]);
    });

    it('marks availability unavailable with one camera', () => {
      const core = new CameraRadioGroupCore();

      core.setMedia(createMediaState({ cameras: [{ deviceId: 'cam-1', kind: 'videoinput', label: 'Built-in' }] }));

      expect(core.getState().availability).toBe('unavailable');
      expect(core.getState().disabled).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns the default label', () => {
      const core = new CameraRadioGroupCore();

      expect(core.getLabel(createState())).toMatchObject({ key: 'publish.camera', text: 'Camera' });
    });

    it('returns a custom string label', () => {
      const core = new CameraRadioGroupCore({ label: 'Video source' });

      expect(core.getLabel(createState())).toBe('Video source');
    });
  });

  describe('getDeviceLabel', () => {
    it('uses a custom formatter', () => {
      const core = new CameraRadioGroupCore({
        formatDevice: (device, index) => `${index}: ${device.label}`,
      });

      expect(core.getDeviceLabel({ deviceId: 'cam-1', kind: 'videoinput', label: 'Built-in' }, 0)).toBe('0: Built-in');
    });
  });

  describe('selectValue', () => {
    it('selects a known camera', () => {
      const core = new CameraRadioGroupCore();
      const media = createMediaState();

      core.selectValue(media, 'cam-2');

      expect(media.selectCamera).toHaveBeenCalledWith('cam-2');
    });

    it('does nothing for an unknown camera', () => {
      const core = new CameraRadioGroupCore();
      const media = createMediaState();

      core.selectValue(media, 'cam-3');

      expect(media.selectCamera).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new CameraRadioGroupCore({ disabled: true });
      const media = createMediaState();

      core.selectValue(media, 'cam-2');

      expect(media.selectCamera).not.toHaveBeenCalled();
    });
  });
});
