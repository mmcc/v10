import type { MediaCaptureTracksState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { MicButtonState } from '../mic-button-core';
import { MicButtonCore } from '../mic-button-core';

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

function createState(overrides: Partial<MicButtonState> = {}): MicButtonState {
  return {
    micMuted: false,
    label: '',
    ...overrides,
  };
}

describe('MicButtonCore', () => {
  describe('getState', () => {
    it('projects micMuted', () => {
      const core = new MicButtonCore();
      core.setMedia(createMediaState({ micMuted: false }));
      expect(core.getState().micMuted).toBe(false);
    });

    it('projects micMuted when muted', () => {
      const core = new MicButtonCore();
      core.setMedia(createMediaState({ micMuted: true }));
      expect(core.getState().micMuted).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns mute microphone when unmuted', () => {
      const core = new MicButtonCore();
      expect(core.getLabel(createState({ micMuted: false }))).toMatchObject({
        key: 'publish.micMute',
        text: 'Mute microphone',
      });
    });

    it('returns unmute microphone when muted', () => {
      const core = new MicButtonCore();
      expect(core.getLabel(createState({ micMuted: true }))).toMatchObject({
        key: 'publish.micUnmute',
        text: 'Unmute microphone',
      });
    });

    it('returns custom string label', () => {
      const core = new MicButtonCore({ label: 'Toggle microphone' });
      expect(core.getLabel(createState())).toBe('Toggle microphone');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new MicButtonCore();
      const attrs = core.getAttrs(createState({ micMuted: false }));
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.micMute', text: 'Mute microphone' });
    });

    it('sets aria-disabled when disabled', () => {
      const core = new MicButtonCore({ disabled: true });
      const attrs = core.getAttrs(createState());
      expect(attrs['aria-disabled']).toBe('true');
    });
  });

  describe('toggle', () => {
    it('calls toggleMicMuted', () => {
      const core = new MicButtonCore();
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleMicMuted).toHaveBeenCalled();
    });

    it('does nothing when disabled', () => {
      const core = new MicButtonCore({ disabled: true });
      const media = createMediaState();
      core.toggle(media);
      expect(media.toggleMicMuted).not.toHaveBeenCalled();
    });
  });
});
