import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureState } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayerWrapper } from '../../../testing/mocks';
import { CapturePlaceholder } from '../capture-placeholder';

afterEach(() => {
  cleanup();
});

function createWrapper({ captureState = 'idle' as MediaCaptureState } = {}) {
  return createPlayerWrapper({
    captureSource: null,
    captureState,
    screenShareAvailability: 'available',
    selectCaptureSource: vi.fn(),
    toggleScreenShare: vi.fn(() => true),
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
});
