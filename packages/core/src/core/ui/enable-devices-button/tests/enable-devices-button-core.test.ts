import type { MediaCaptureSourceState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { EnableDevicesButtonState } from '../enable-devices-button-core';
import { EnableDevicesButtonCore } from '../enable-devices-button-core';

function createMediaState(overrides: Partial<MediaCaptureSourceState> = {}): MediaCaptureSourceState {
  return {
    captureSource: null,
    captureState: 'idle',
    screenShareAvailability: 'available',
    selectCaptureSource: vi.fn(),
    toggleScreenShare: vi.fn(() => true),
    ...overrides,
  };
}

function createState(overrides: Partial<EnableDevicesButtonState> = {}): EnableDevicesButtonState {
  return {
    captureState: 'idle',
    disabled: false,
    label: '',
    ...overrides,
  };
}

describe('EnableDevicesButtonCore', () => {
  describe('getState', () => {
    it('is enabled when idle', () => {
      const core = new EnableDevicesButtonCore();
      core.setMedia(createMediaState({ captureState: 'idle' }));

      const state = core.getState();

      expect(state.captureState).toBe('idle');
      expect(state.disabled).toBe(false);
    });

    it('is disabled while acquiring', () => {
      const core = new EnableDevicesButtonCore();
      core.setMedia(createMediaState({ captureState: 'acquiring' }));
      expect(core.getState().disabled).toBe(true);
    });

    it('is disabled via props', () => {
      const core = new EnableDevicesButtonCore({ disabled: true });
      core.setMedia(createMediaState());
      expect(core.getState().disabled).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns the default label', () => {
      const core = new EnableDevicesButtonCore();
      expect(core.getLabel(createState())).toMatchObject({
        key: 'publish.enableDevices',
        text: 'Enable camera and microphone',
      });
    });

    it('returns custom string label', () => {
      const core = new EnableDevicesButtonCore({ label: 'Allow devices' });
      expect(core.getLabel(createState())).toBe('Allow devices');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new EnableDevicesButtonCore();
      const attrs = core.getAttrs(createState());
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.enableDevices' });
    });

    it('sets aria-disabled from derived disabled state', () => {
      const core = new EnableDevicesButtonCore();
      const attrs = core.getAttrs(createState({ disabled: true }));
      expect(attrs['aria-disabled']).toBe('true');
    });
  });

  describe('activate', () => {
    it('selects the camera capture source', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState();

      core.activate(media);

      expect(media.selectCaptureSource).toHaveBeenCalledWith('camera');
    });

    it('does nothing while acquiring', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState({ captureState: 'acquiring' });

      core.activate(media);

      expect(media.selectCaptureSource).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new EnableDevicesButtonCore({ disabled: true });
      const media = createMediaState();

      core.activate(media);

      expect(media.selectCaptureSource).not.toHaveBeenCalled();
    });
  });
});
