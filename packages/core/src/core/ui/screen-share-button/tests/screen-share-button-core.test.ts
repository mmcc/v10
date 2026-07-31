import type { MediaCaptureSourceState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenShareButtonState } from '../screen-share-button-core';
import { ScreenShareButtonCore } from '../screen-share-button-core';

function createMediaState(overrides: Partial<MediaCaptureSourceState> = {}): MediaCaptureSourceState {
  return {
    captureSource: 'camera',
    captureState: 'active',
    screenShareAvailability: 'available',
    selectCaptureSource: vi.fn(),
    toggleScreenShare: vi.fn(() => true),
    ...overrides,
  };
}

function createState(overrides: Partial<ScreenShareButtonState> = {}): ScreenShareButtonState {
  return {
    sharing: false,
    availability: 'available',
    label: '',
    ...overrides,
  };
}

describe('ScreenShareButtonCore', () => {
  describe('getState', () => {
    it('reports sharing when the screen is the capture source', () => {
      const core = new ScreenShareButtonCore();
      core.setMedia(createMediaState({ captureSource: 'screen' }));
      expect(core.getState().sharing).toBe(true);
    });

    it('reports not sharing for camera or released capture', () => {
      const core = new ScreenShareButtonCore();
      core.setMedia(createMediaState({ captureSource: 'camera' }));
      expect(core.getState().sharing).toBe(false);

      core.setMedia(createMediaState({ captureSource: null }));
      expect(core.getState().sharing).toBe(false);
    });

    it('projects screen share availability', () => {
      const core = new ScreenShareButtonCore();
      core.setMedia(createMediaState({ screenShareAvailability: 'unsupported' }));
      expect(core.getState().availability).toBe('unsupported');
    });
  });

  describe('getLabel', () => {
    it('returns share screen when not sharing', () => {
      const core = new ScreenShareButtonCore();
      expect(core.getLabel(createState({ sharing: false }))).toMatchObject({
        key: 'publish.shareScreen',
        text: 'Share screen',
      });
    });

    it('returns stop sharing when sharing', () => {
      const core = new ScreenShareButtonCore();
      expect(core.getLabel(createState({ sharing: true }))).toMatchObject({
        key: 'publish.stopSharing',
        text: 'Stop sharing',
      });
    });

    it('returns custom string label', () => {
      const core = new ScreenShareButtonCore({ label: 'Present' });
      expect(core.getLabel(createState())).toBe('Present');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new ScreenShareButtonCore();
      const attrs = core.getAttrs(createState({ sharing: false }));
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.shareScreen', text: 'Share screen' });
    });

    it('sets aria-disabled when disabled', () => {
      const core = new ScreenShareButtonCore({ disabled: true });
      const attrs = core.getAttrs(createState());
      expect(attrs['aria-disabled']).toBe('true');
    });
  });

  describe('toggle', () => {
    it('calls toggleScreenShare', () => {
      const core = new ScreenShareButtonCore();
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleScreenShare).toHaveBeenCalled();
    });

    it('does nothing when screen share is unavailable', () => {
      const core = new ScreenShareButtonCore();
      const media = createMediaState({ screenShareAvailability: 'unsupported' });
      core.toggle(media);
      expect(media.toggleScreenShare).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new ScreenShareButtonCore({ disabled: true });
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleScreenShare).not.toHaveBeenCalled();
    });
  });
});
