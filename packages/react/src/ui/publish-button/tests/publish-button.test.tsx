import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MediaCaptureState, MediaPublishSessionState } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { PublishButton } from '../publish-button';

afterEach(cleanup);

function createWrapper({
  publishState = 'idle' as MediaPublishSessionState,
  captureState = 'active' as MediaCaptureState,
  micState = 'idle' as MediaCaptureState,
  micActive = false,
  micExplicit = false,
  publish = vi.fn(() => Promise.resolve()),
  unpublish = vi.fn(),
} = {}) {
  const { Wrapper } = createPlayerWrapper({
    // `publish` feature slice
    publishState,
    publishStartedAt: Number.NaN,
    publish,
    unpublish,
    // `captureSource` feature slice
    cameraActive: captureState === 'active',
    screenShareActive: false,
    micActive,
    micExplicit,
    cameraState: captureState,
    screenShareState: 'idle',
    micState,
    screenShareAvailability: 'available',
    toggleCamera: vi.fn(),
    toggleScreenShare: vi.fn(),
    toggleMic: vi.fn(),
  });

  return { Wrapper, publish, unpublish };
}

describe('PublishButton', () => {
  it('renders the default "Go live" label while idle', () => {
    const { Wrapper } = createWrapper();

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    const button = screen.getByTestId('publish');

    expect(button.textContent).toBe('Go live');
    expect(button.getAttribute('data-publish-state')).toBe('idle');
    expect(button.hasAttribute('data-disabled')).toBe(false);
  });

  it('is disabled until capture is active', () => {
    const { Wrapper, publish } = createWrapper({ captureState: 'idle' });

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    const button = screen.getByTestId('publish');

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('data-disabled')).toBe(true);

    fireEvent.click(button);
    expect(publish).not.toHaveBeenCalled();
  });

  it('enables and starts a session from a mic-only capture', () => {
    const { Wrapper, publish } = createWrapper({
      captureState: 'idle',
      micState: 'active',
      micActive: true,
      micExplicit: true,
    });

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    const button = screen.getByTestId('publish');

    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.hasAttribute('data-disabled')).toBe(false);

    fireEvent.click(button);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('stays disabled on an implied mic without explicit intent', () => {
    const { Wrapper, publish } = createWrapper({
      captureState: 'idle',
      micState: 'active',
      micActive: false,
      micExplicit: false,
    });

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    const button = screen.getByTestId('publish');

    expect(button.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(button);
    expect(publish).not.toHaveBeenCalled();
  });

  it('starts a session when activated while idle with active capture', () => {
    const { Wrapper, publish, unpublish } = createWrapper();

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    fireEvent.click(screen.getByTestId('publish'));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(unpublish).not.toHaveBeenCalled();
  });

  it('stops the session when activated while live', () => {
    const { Wrapper, publish, unpublish } = createWrapper({ publishState: 'live' });

    render(<PublishButton data-testid="publish" />, { wrapper: Wrapper });

    const button = screen.getByTestId('publish');

    expect(button.textContent).toBe('Stop stream');
    expect(button.getAttribute('data-publish-state')).toBe('live');

    fireEvent.click(button);

    expect(unpublish).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('preserves authored content', () => {
    const { Wrapper } = createWrapper();

    render(<PublishButton data-testid="publish">Broadcast</PublishButton>, { wrapper: Wrapper });

    expect(screen.getByTestId('publish').textContent).toBe('Broadcast');
  });
});
