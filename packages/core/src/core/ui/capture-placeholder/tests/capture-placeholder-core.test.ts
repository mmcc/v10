import type { MediaCaptureSourceState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { CapturePlaceholderState } from '../capture-placeholder-core';
import { CapturePlaceholderCore } from '../capture-placeholder-core';

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

function createState(overrides: Partial<CapturePlaceholderState> = {}): CapturePlaceholderState {
  return {
    captureState: 'idle',
    label: '',
    ...overrides,
  };
}

describe('CapturePlaceholderCore', () => {
  describe('getState', () => {
    it('projects the capture state and label', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ captureState: 'denied' }));

      const state = core.getState();

      expect(state.captureState).toBe('denied');
      expect(state.label).toBe('Camera and microphone access is blocked. Update your browser permissions to continue.');
    });
  });

  describe('getLabel', () => {
    it('returns the enable devices CTA when idle', () => {
      const core = new CapturePlaceholderCore();
      expect(core.getLabel(createState({ captureState: 'idle' }))).toMatchObject({
        key: 'publish.enableDevices',
        text: 'Enable camera and microphone',
      });
    });

    it('returns the enable devices CTA when ended', () => {
      const core = new CapturePlaceholderCore();
      expect(core.getLabel(createState({ captureState: 'ended' }))).toMatchObject({
        key: 'publish.enableDevices',
      });
    });

    it('returns connecting while acquiring', () => {
      const core = new CapturePlaceholderCore();
      expect(core.getLabel(createState({ captureState: 'acquiring' }))).toMatchObject({
        key: 'publish.connecting',
        text: 'Connecting…',
      });
    });

    it('returns permission guidance when denied', () => {
      const core = new CapturePlaceholderCore();
      expect(core.getLabel(createState({ captureState: 'denied' }))).toMatchObject({
        key: 'publish.permissionDenied',
      });
    });

    it('returns an empty label when active', () => {
      const core = new CapturePlaceholderCore();
      expect(core.getLabel(createState({ captureState: 'active' }))).toBe('');
    });

    it('returns custom string label', () => {
      const core = new CapturePlaceholderCore({ label: 'Get started' });
      expect(core.getLabel(createState())).toBe('Get started');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new CapturePlaceholderCore();
      const attrs = core.getAttrs(createState({ captureState: 'idle' }));
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.enableDevices' });
    });

    it('omits aria-label when the label is empty', () => {
      const core = new CapturePlaceholderCore();
      const attrs = core.getAttrs(createState({ captureState: 'active' }));
      expect(attrs['aria-label']).toBeUndefined();
    });
  });
});
