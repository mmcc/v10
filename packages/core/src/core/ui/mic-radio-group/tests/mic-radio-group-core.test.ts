import type { MediaCaptureDevicesState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { MicRadioGroupState } from '../mic-radio-group-core';
import { MicRadioGroupCore } from '../mic-radio-group-core';

function createMediaState(overrides: Partial<MediaCaptureDevicesState> = {}): MediaCaptureDevicesState {
  return {
    cameras: [],
    microphones: [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Microphone' },
      { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Microphone' },
    ],
    selectedCameraId: '',
    selectedMicrophoneId: 'mic-1',
    selectCamera: vi.fn(),
    selectMicrophone: vi.fn(),
    ...overrides,
  };
}

function createState(overrides: Partial<MicRadioGroupState> = {}): MicRadioGroupState {
  return {
    devices: [
      { value: 'mic-1', label: 'Built-in Microphone' },
      { value: 'mic-2', label: 'USB Microphone' },
    ],
    value: 'mic-1',
    disabled: false,
    availability: 'available',
    label: '',
    ...overrides,
  };
}

describe('MicRadioGroupCore', () => {
  describe('getState', () => {
    it('projects microphones', () => {
      const core = new MicRadioGroupCore();
      core.setMedia(createMediaState());

      const state = core.getState();

      expect(state.devices).toEqual([
        { value: 'mic-1', label: 'Built-in Microphone' },
        { value: 'mic-2', label: 'USB Microphone' },
      ]);
      expect(state.value).toBe('mic-1');
    });

    it('falls back to numbered labels when device labels are empty', () => {
      const core = new MicRadioGroupCore();
      core.setMedia(
        createMediaState({
          microphones: [
            { deviceId: 'mic-1', kind: 'audioinput', label: '' },
            { deviceId: 'mic-2', kind: 'audioinput', label: '' },
          ],
        })
      );

      expect(core.getState().devices).toEqual([
        { value: 'mic-1', label: 'Microphone 1' },
        { value: 'mic-2', label: 'Microphone 2' },
      ]);
    });

    it('marks availability unavailable with one microphone', () => {
      const core = new MicRadioGroupCore();
      core.setMedia(createMediaState({ microphones: [{ deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in' }] }));

      expect(core.getState().availability).toBe('unavailable');
      expect(core.getState().disabled).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns the default label', () => {
      const core = new MicRadioGroupCore();
      expect(core.getLabel(createState())).toMatchObject({ key: 'publish.microphone', text: 'Microphone' });
    });

    it('returns a custom string label', () => {
      const core = new MicRadioGroupCore({ label: 'Audio source' });
      expect(core.getLabel(createState())).toBe('Audio source');
    });
  });

  describe('getDeviceLabel', () => {
    it('uses a custom formatter', () => {
      const core = new MicRadioGroupCore({
        formatDevice: (device, index) => `${index}: ${device.label}`,
      });

      expect(core.getDeviceLabel({ deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in' }, 0)).toBe('0: Built-in');
    });
  });

  describe('selectValue', () => {
    it('selects a known microphone', () => {
      const core = new MicRadioGroupCore();
      const media = createMediaState();

      core.selectValue(media, 'mic-2');

      expect(media.selectMicrophone).toHaveBeenCalledWith('mic-2');
    });

    it('does nothing for an unknown microphone', () => {
      const core = new MicRadioGroupCore();
      const media = createMediaState();

      core.selectValue(media, 'mic-3');

      expect(media.selectMicrophone).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new MicRadioGroupCore({ disabled: true });
      const media = createMediaState();

      core.selectValue(media, 'mic-2');

      expect(media.selectMicrophone).not.toHaveBeenCalled();
    });
  });
});
