import { act, cleanup, render, screen } from '@testing-library/react';
import type { MediaPublishSessionState } from '@videojs/media';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlayerWrapper } from '../../../testing/mocks';
import { PublishTimer } from '../publish-timer';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function createWrapper({ publishState = 'idle' as MediaPublishSessionState, publishStartedAt = Number.NaN } = {}) {
  return createPlayerWrapper({
    publishState,
    publishStartedAt,
    publish: vi.fn(() => Promise.resolve()),
    unpublish: vi.fn(),
  }).Wrapper;
}

describe('PublishTimer', () => {
  it('renders 0:00 before the session first goes live', () => {
    const Wrapper = createWrapper();

    render(<PublishTimer data-testid="timer" />, { wrapper: Wrapper });

    const timer = screen.getByTestId('timer');
    expect(timer.textContent).toBe('0:00');
    expect(timer.getAttribute('data-publish-state')).toBe('idle');
  });

  it('ticks every second while live', () => {
    const Wrapper = createWrapper({ publishState: 'live', publishStartedAt: Date.now() - 65_000 });

    render(<PublishTimer data-testid="timer" />, { wrapper: Wrapper });

    const timer = screen.getByTestId('timer');
    expect(timer.textContent).toBe('1:05');

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(timer.textContent).toBe('1:07');
  });

  it('does not tick while the session is not live', () => {
    const Wrapper = createWrapper();

    render(<PublishTimer data-testid="timer" />, { wrapper: Wrapper });

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByTestId('timer').textContent).toBe('0:00');
    // No interval is scheduled at all while idle.
    expect(vi.getTimerCount()).toBe(0);
  });
});
