import type { MediaCaptureSourceState } from '@videojs/media';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { EnableDevicesButtonState } from '../enable-devices-button-core';
import { EnableDevicesButtonCore } from '../enable-devices-button-core';

function createMediaState(overrides: Partial<MediaCaptureSourceState> = {}): MediaCaptureSourceState {
  return {
    cameraActive: false,
    screenShareActive: false,
    micActive: false,
    micExplicit: false,
    cameraState: 'idle',
    screenShareState: 'idle',
    micState: 'idle',
    screenShareAvailability: 'available',
    toggleCamera: vi.fn(() => true),
    toggleScreenShare: vi.fn(() => true),
    toggleMic: vi.fn(() => true),
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

      core.setMedia(createMediaState({ cameraState: 'idle' }));

      const state = core.getState();

      expect(state.captureState).toBe('idle');
      expect(state.disabled).toBe(false);
    });

    it('is disabled while the camera is acquiring', () => {
      const core = new EnableDevicesButtonCore();

      core.setMedia(createMediaState({ cameraState: 'acquiring' }));
      expect(core.getState().disabled).toBe(true);
    });

    it('stays enabled while the screen share is acquiring — the pipelines are independent', () => {
      const core = new EnableDevicesButtonCore();

      core.setMedia(createMediaState({ screenShareState: 'acquiring' }));
      expect(core.getState().disabled).toBe(false);
    });

    it('reflects a mic-only capture as active', () => {
      const core = new EnableDevicesButtonCore();

      core.setMedia(createMediaState({ micState: 'active', micActive: true, micExplicit: true }));
      expect(core.getState().captureState).toBe('active');
    });

    it('ignores an implied mic when reporting the capture state', () => {
      const core = new EnableDevicesButtonCore();

      core.setMedia(createMediaState({ micState: 'active', micExplicit: false }));
      expect(core.getState().captureState).toBe('idle');
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
    it('activates the camera', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState();

      core.activate(media);

      expect(media.toggleCamera).toHaveBeenCalled();
    });

    it('does nothing when the camera is already active', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState({ cameraActive: true, cameraState: 'active' });

      core.activate(media);

      expect(media.toggleCamera).not.toHaveBeenCalled();
    });

    it('does nothing while acquiring', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState({ cameraState: 'acquiring' });

      core.activate(media);

      expect(media.toggleCamera).not.toHaveBeenCalled();
    });

    it('retries after a denial — the consumed intent reads false, so the same click re-acquires', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState({ cameraActive: false, cameraState: 'denied' });

      core.activate(media);

      expect(media.toggleCamera).toHaveBeenCalled();
    });

    it('retries after an out-of-band end (device unplugged and replugged)', () => {
      const core = new EnableDevicesButtonCore();
      const media = createMediaState({ cameraActive: false, cameraState: 'ended' });

      core.activate(media);

      expect(media.toggleCamera).toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new EnableDevicesButtonCore({ disabled: true });
      const media = createMediaState();

      core.activate(media);

      expect(media.toggleCamera).not.toHaveBeenCalled();
    });
  });
});
