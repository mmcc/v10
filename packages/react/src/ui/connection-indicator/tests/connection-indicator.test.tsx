import { cleanup, render, screen } from '@testing-library/react';
import type { MediaConnectionQuality } from '@videojs/media';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { ConnectionIndicator } from '../connection-indicator';

afterEach(() => {
  cleanup();
});

function createWrapper({ connectionQuality = 'unknown' as MediaConnectionQuality } = {}) {
  return createPlayerWrapper({
    publishStats: null,
    connectionQuality,
  }).Wrapper;
}

describe('ConnectionIndicator', () => {
  it('exposes the quality as the accessible label', () => {
    const Wrapper = createWrapper({ connectionQuality: 'poor' });

    render(<ConnectionIndicator data-testid="indicator" />, { wrapper: Wrapper });

    const indicator = screen.getByTestId('indicator');

    expect(indicator.getAttribute('role')).toBe('img');
    expect(indicator.getAttribute('aria-label')).toBe('Connection quality: poor');
    expect(indicator.getAttribute('data-quality')).toBe('poor');
  });

  it('labels the unknown state before the first sample', () => {
    const Wrapper = createWrapper();

    render(<ConnectionIndicator data-testid="indicator" />, { wrapper: Wrapper });

    const indicator = screen.getByTestId('indicator');

    expect(indicator.getAttribute('aria-label')).toBe('Connection quality: unknown');
    expect(indicator.getAttribute('data-quality')).toBe('unknown');
  });
});
