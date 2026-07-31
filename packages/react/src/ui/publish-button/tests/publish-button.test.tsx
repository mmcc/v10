import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MediaCaptureState, MediaPublishSessionState } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayerWrapper } from '../../../testing/mocks';
import { PublishButton } from '../publish-button';

afterEach(cleanup);

function createWrapper({
  publishState = 'idle' as MediaPublishSessionState,
  captureState = 'active' as MediaCaptureState,
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
    captureSource: captureState === 'active' ? 'camera' : null,
    captureState,
    screenShareAvailability: 'available',
    selectCaptureSource: vi.fn(),
    toggleScreenShare: vi.fn(),
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
