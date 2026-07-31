import type { MediaPublishStatsState } from '@videojs/media';
import { describe, expect, it } from 'vitest';
import type { ConnectionIndicatorState } from '../connection-indicator-core';
import { ConnectionIndicatorCore } from '../connection-indicator-core';

function createMediaState(overrides: Partial<MediaPublishStatsState> = {}): MediaPublishStatsState {
  return {
    publishStats: null,
    connectionQuality: 'unknown',
    ...overrides,
  };
}

function createState(overrides: Partial<ConnectionIndicatorState> = {}): ConnectionIndicatorState {
  return {
    quality: 'unknown',
    label: '',
    ...overrides,
  };
}

describe('ConnectionIndicatorCore', () => {
  describe('getState', () => {
    it('projects the connection quality', () => {
      const core = new ConnectionIndicatorCore();
      core.setMedia(createMediaState({ connectionQuality: 'good' }));
      expect(core.getState().quality).toBe('good');
    });

    it('reports unknown before the first sample', () => {
      const core = new ConnectionIndicatorCore();
      core.setMedia(createMediaState());
      expect(core.getState().quality).toBe('unknown');
    });
  });

  describe('getLabel', () => {
    it('returns a label naming the current quality', () => {
      const core = new ConnectionIndicatorCore();
      expect(core.getLabel(createState())).toMatchObject({
        key: 'publish.connectionUnknown',
        text: 'Connection quality: unknown',
      });
      expect(core.getLabel(createState({ quality: 'good' }))).toMatchObject({
        key: 'publish.connectionGood',
        text: 'Connection quality: good',
      });
      expect(core.getLabel(createState({ quality: 'fair' }))).toMatchObject({
        key: 'publish.connectionFair',
        text: 'Connection quality: fair',
      });
      expect(core.getLabel(createState({ quality: 'poor' }))).toMatchObject({
        key: 'publish.connectionPoor',
        text: 'Connection quality: poor',
      });
    });

    it('returns custom string label', () => {
      const core = new ConnectionIndicatorCore({ label: 'Signal' });
      expect(core.getLabel(createState())).toBe('Signal');
    });
  });

  describe('getAttrs', () => {
    it('exposes the quality as the accessible label', () => {
      const core = new ConnectionIndicatorCore();
      const attrs = core.getAttrs(createState({ quality: 'poor' }));
      expect(attrs.role).toBe('img');
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.connectionPoor' });
    });
  });
});
