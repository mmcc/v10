import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureState } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { CapturePlaceholder } from '../capture-placeholder';

afterEach(() => {
  cleanup();
});

function createWrapper({
  captureState = 'idle' as MediaCaptureState,
  micState = 'idle' as MediaCaptureState,
  micActive = false,
  micExplicit = false,
} = {}) {
  return createPlayerWrapper({
    cameraActive: false,
    screenShareActive: false,
    micActive,
    micExplicit,
    cameraState: captureState,
    screenShareState: 'idle',
    micState,
    screenShareAvailability: 'available',
    toggleCamera: vi.fn(() => true),
    toggleScreenShare: vi.fn(() => true),
    toggleMic: vi.fn(() => true),
  }).Wrapper;
}

describe('CapturePlaceholder', () => {
  it('renders the guidance text and aria-label without children', () => {
    const Wrapper = createWrapper();

    render(<CapturePlaceholder data-testid="placeholder" />, { wrapper: Wrapper });

    const placeholder = screen.getByTestId('placeholder');

    expect(placeholder.textContent).toBe('Enable camera and microphone');
    expect(placeholder.getAttribute('aria-label')).toBe('Enable camera and microphone');
    expect(placeholder.getAttribute('data-capture-state')).toBe('idle');
  });

  it('does not apply an aria-label when children are provided', () => {
    const Wrapper = createWrapper();

    render(
      <CapturePlaceholder data-testid="placeholder">
        <div>Custom content</div>
      </CapturePlaceholder>,
      { wrapper: Wrapper }
    );

    const placeholder = screen.getByTestId('placeholder');

    expect(placeholder.textContent).toBe('Custom content');
    expect(placeholder.hasAttribute('aria-label')).toBe(false);
  });

  it('reports a mic-only capture as active and clears the guidance', () => {
    const Wrapper = createWrapper({ micState: 'active', micActive: true, micExplicit: true });

    render(<CapturePlaceholder data-testid="placeholder" />, { wrapper: Wrapper });

    const placeholder = screen.getByTestId('placeholder');

    expect(placeholder.getAttribute('data-capture-state')).toBe('active');
    expect(placeholder.textContent).toBe('');
  });

  it('keeps the guidance up when only an implied mic is live', () => {
    const Wrapper = createWrapper({ micState: 'active', micActive: false, micExplicit: false });

    render(<CapturePlaceholder data-testid="placeholder" />, { wrapper: Wrapper });

    const placeholder = screen.getByTestId('placeholder');

    expect(placeholder.getAttribute('data-capture-state')).toBe('idle');
    expect(placeholder.textContent).toBe('Enable camera and microphone');
  });

  it('keeps permission guidance after a mic-only denial consumes the intent', () => {
    const Wrapper = createWrapper({ micState: 'denied', micActive: false, micExplicit: true });

    render(<CapturePlaceholder data-testid="placeholder" />, { wrapper: Wrapper });

    const placeholder = screen.getByTestId('placeholder');

    expect(placeholder.getAttribute('data-capture-state')).toBe('denied');
    expect(placeholder.textContent).toBe(
      'Camera and microphone access is blocked. Update your browser permissions to continue.'
    );
  });
});
