import type { MediaCaptureSourceState } from '@videojs/media';
import { describe, expect, it, vi } from 'vitest';
import type { CapturePlaceholderState } from '../capture-placeholder-core';
import { CapturePlaceholderCore } from '../capture-placeholder-core';

function createMediaState(overrides: Partial<MediaCaptureSourceState> = {}): MediaCaptureSourceState {
  return {
    cameraActive: false,
    screenShareActive: false,
    micActive: false,
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

function createState(overrides: Partial<CapturePlaceholderState> = {}): CapturePlaceholderState {
  return {
    captureState: 'idle',
    label: '',
    ...overrides,
  };
}

describe('CapturePlaceholderCore', () => {
  describe('getState', () => {
    it('projects the aggregate capture state and label', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ cameraState: 'denied' }));

      const state = core.getState();

      expect(state.captureState).toBe('denied');
      expect(state.label).toBe('Camera and microphone access is blocked. Update your browser permissions to continue.');
    });

    it('is active when either source is active', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ cameraState: 'idle', screenShareState: 'active' }));

      expect(core.getState().captureState).toBe('active');
    });

    it('clears the placeholder for a mic-only capture', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ micState: 'active', micActive: true }));

      const state = core.getState();
      expect(state.captureState).toBe('active');
      expect(state.label).toBe('');
    });

    it('keeps the CTA up when only an implied mic is live', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ micState: 'active', micActive: false }));

      const state = core.getState();
      expect(state.captureState).toBe('idle');
      expect(state.label).toBe('Enable camera and microphone');
    });

    it('shows permission guidance after a mic-only denial consumes the intent', () => {
      // The acquire pipeline sets micActive back to false on denial while
      // parking micState — the guidance must survive that consumption.
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ micState: 'denied', micActive: false }));

      const state = core.getState();
      expect(state.captureState).toBe('denied');
      expect(state.label).toBe('Camera and microphone access is blocked. Update your browser permissions to continue.');
    });

    it('prefers the more in-progress status when the two disagree', () => {
      const core = new CapturePlaceholderCore();
      core.setMedia(createMediaState({ cameraState: 'idle', screenShareState: 'acquiring' }));

      expect(core.getState().captureState).toBe('acquiring');
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
