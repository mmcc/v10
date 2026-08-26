import type { MediaPublishState } from '@videojs/media';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { PublishBadgeState } from '../publish-badge-core';
import { PublishBadgeCore } from '../publish-badge-core';

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

function createState(overrides: Partial<PublishBadgeState> = {}): PublishBadgeState {
  return {
    session: 'idle',
    label: '',
    ...overrides,
  };
}

describe('PublishBadgeCore', () => {
  describe('getState', () => {
    it('projects the publish session and label', () => {
      const core = new PublishBadgeCore();

      core.setMedia(createMediaState({ publishState: 'live' }));

      const state = core.getState();

      expect(state.session).toBe('live');
      expect(state.label).toBe('Live');
    });
  });

  describe('getLabel', () => {
    it('returns live when publishing', () => {
      const core = new PublishBadgeCore();

      expect(core.getLabel(createState({ session: 'live' }))).toMatchObject({ key: 'live.badge', text: 'Live' });
    });

    it('returns connecting during session setup', () => {
      const core = new PublishBadgeCore();

      expect(core.getLabel(createState({ session: 'connecting' }))).toMatchObject({
        key: 'publish.connecting',
        text: 'Connecting…',
      });
    });

    it('returns offline when idle', () => {
      const core = new PublishBadgeCore();

      expect(core.getLabel(createState({ session: 'idle' }))).toMatchObject({
        key: 'publish.offline',
        text: 'Offline',
      });
    });

    it('returns offline when stopping or errored', () => {
      const core = new PublishBadgeCore();

      expect(core.getLabel(createState({ session: 'stopping' }))).toMatchObject({ key: 'publish.offline' });
      expect(core.getLabel(createState({ session: 'error' }))).toMatchObject({ key: 'publish.offline' });
    });

    it('returns custom string label', () => {
      const core = new PublishBadgeCore({ label: 'On air' });

      expect(core.getLabel(createState({ session: 'live' }))).toBe('On air');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new PublishBadgeCore();
      const attrs = core.getAttrs(createState({ session: 'live' }));

      expect(attrs['aria-label']).toMatchObject({ key: 'live.badge', text: 'Live' });
    });
  });
});
