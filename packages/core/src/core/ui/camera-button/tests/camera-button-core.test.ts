import type { MediaCaptureTracksState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { CameraButtonState } from '../camera-button-core';
import { CameraButtonCore } from '../camera-button-core';

function createMediaState(overrides: Partial<MediaCaptureTracksState> = {}): MediaCaptureTracksState {
  return {
    cameraMuted: false,
    micMuted: false,
    setCameraMuted: vi.fn(),
    toggleCameraMuted: vi.fn(() => true),
    setMicMuted: vi.fn(),
    toggleMicMuted: vi.fn(() => true),
    ...overrides,
  };
}

function createState(overrides: Partial<CameraButtonState> = {}): CameraButtonState {
  return {
    cameraMuted: false,
    label: '',
    ...overrides,
  };
}

describe('CameraButtonCore', () => {
  describe('getState', () => {
    it('projects cameraMuted', () => {
      const core = new CameraButtonCore();
      core.setMedia(createMediaState({ cameraMuted: false }));
      expect(core.getState().cameraMuted).toBe(false);
    });

    it('projects cameraMuted when muted', () => {
      const core = new CameraButtonCore();
      core.setMedia(createMediaState({ cameraMuted: true }));
      expect(core.getState().cameraMuted).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns turn camera off when unmuted', () => {
      const core = new CameraButtonCore();
      expect(core.getLabel(createState({ cameraMuted: false }))).toMatchObject({
        key: 'publish.cameraOff',
        text: 'Turn camera off',
      });
    });

    it('returns turn camera on when muted', () => {
      const core = new CameraButtonCore();
      expect(core.getLabel(createState({ cameraMuted: true }))).toMatchObject({
        key: 'publish.cameraOn',
        text: 'Turn camera on',
      });
    });

    it('returns custom string label', () => {
      const core = new CameraButtonCore({ label: 'Toggle camera' });
      expect(core.getLabel(createState())).toBe('Toggle camera');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new CameraButtonCore();
      const attrs = core.getAttrs(createState({ cameraMuted: false }));
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.cameraOff', text: 'Turn camera off' });
    });

    it('sets aria-disabled when disabled', () => {
      const core = new CameraButtonCore({ disabled: true });
      const attrs = core.getAttrs(createState());
      expect(attrs['aria-disabled']).toBe('true');
    });
  });

  describe('toggle', () => {
    it('calls toggleCameraMuted', () => {
      const core = new CameraButtonCore();
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleCameraMuted).toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new CameraButtonCore({ disabled: true });
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleCameraMuted).not.toHaveBeenCalled();
    });
  });
});
