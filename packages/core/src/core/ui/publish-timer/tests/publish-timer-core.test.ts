import type { MediaPublishState } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { PublishTimerState } from '../publish-timer-core';
import { PublishTimerCore } from '../publish-timer-core';

function createMediaState(overrides: Partial<MediaPublishState> = {}): MediaPublishState {
  return {
    publishState: 'idle',
    publishStartedAt: Number.NaN,
    publishError: null,
    publish: vi.fn(async () => {}),
    unpublish: vi.fn(),
    ...overrides,
  };
}

function createState(overrides: Partial<PublishTimerState> = {}): PublishTimerState {
  return {
    session: 'idle',
    elapsedText: '0:00',
    label: '',
    ...overrides,
  };
}

describe('PublishTimerCore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getState', () => {
    it('formats elapsed time from publishStartedAt and now', () => {
      const core = new PublishTimerCore({ now: 100_000 + 90_000 });

      core.setMedia(createMediaState({ publishState: 'live', publishStartedAt: 100_000 }));

      const state = core.getState();

      expect(state.session).toBe('live');
      expect(state.elapsedText).toBe('1:30');
    });

    it('formats hours as H:MM:SS', () => {
      const core = new PublishTimerCore({ now: 3_661_000 });

      core.setMedia(createMediaState({ publishState: 'live', publishStartedAt: 0 }));

      expect(core.getState().elapsedText).toBe('1:01:01');
    });

    it('returns zero before the session first goes live', () => {
      const core = new PublishTimerCore({ now: 90_000 });

      core.setMedia(createMediaState({ publishState: 'idle', publishStartedAt: Number.NaN }));

      expect(core.getState().elapsedText).toBe('0:00');
    });

    it('clamps negative elapsed time to zero', () => {
      const core = new PublishTimerCore({ now: 50_000 });

      core.setMedia(createMediaState({ publishState: 'live', publishStartedAt: 100_000 }));

      expect(core.getState().elapsedText).toBe('0:00');
    });

    it('falls back to Date.now() when now is unset', () => {
      vi.spyOn(Date, 'now').mockReturnValue(160_000);

      const core = new PublishTimerCore();

      core.setMedia(createMediaState({ publishState: 'live', publishStartedAt: 100_000 }));

      expect(core.getState().elapsedText).toBe('1:00');
    });
  });

  describe('getLabel', () => {
    it('returns the default label', () => {
      const core = new PublishTimerCore();

      expect(core.getLabel(createState())).toMatchObject({
        key: 'publish.streamDuration',
        text: 'Stream duration',
      });
    });

    it('returns custom string label', () => {
      const core = new PublishTimerCore({ label: 'Elapsed' });

      expect(core.getLabel(createState())).toBe('Elapsed');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new PublishTimerCore();
      const attrs = core.getAttrs(createState());

      expect(attrs['aria-label']).toMatchObject({ key: 'publish.streamDuration', text: 'Stream duration' });
    });
  });
});
