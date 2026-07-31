import { describe, expect, it, vi } from 'vitest';
import type { PublishButtonMediaState, PublishButtonState } from '../publish-button-core';
import { PublishButtonCore } from '../publish-button-core';

function createMediaState(overrides: Partial<PublishButtonMediaState> = {}): PublishButtonMediaState {
  return {
    publishState: 'idle',
    publishStartedAt: Number.NaN,
    publishError: null,
    publish: vi.fn(async () => {}),
    unpublish: vi.fn(),
    captureState: 'active',
    ...overrides,
  };
}

function createState(overrides: Partial<PublishButtonState> = {}): PublishButtonState {
  return {
    session: 'idle',
    disabled: false,
    label: '',
    ...overrides,
  };
}

describe('PublishButtonCore', () => {
  describe('getState', () => {
    it('projects the publish session', () => {
      const core = new PublishButtonCore();
      core.setMedia(createMediaState({ publishState: 'live' }));
      const state = core.getState();

      expect(state.session).toBe('live');
      expect(state.disabled).toBe(false);
    });

    it('is enabled when idle with active capture', () => {
      const core = new PublishButtonCore();
      core.setMedia(createMediaState());
      expect(core.getState().disabled).toBe(false);
    });

    it('is disabled when capture is not active', () => {
      const core = new PublishButtonCore();
      core.setMedia(createMediaState({ captureState: 'idle' }));
      expect(core.getState().disabled).toBe(true);
    });

    it('is disabled while connecting', () => {
      const core = new PublishButtonCore();
      core.setMedia(createMediaState({ publishState: 'connecting' }));
      expect(core.getState().disabled).toBe(true);
    });

    it('is disabled while stopping', () => {
      const core = new PublishButtonCore();
      core.setMedia(createMediaState({ publishState: 'stopping' }));
      expect(core.getState().disabled).toBe(true);
    });

    it('is disabled via props', () => {
      const core = new PublishButtonCore({ disabled: true });
      core.setMedia(createMediaState());
      expect(core.getState().disabled).toBe(true);
    });
  });

  describe('getLabel', () => {
    it('returns go live when idle', () => {
      const core = new PublishButtonCore();
      expect(core.getLabel(createState({ session: 'idle' }))).toMatchObject({
        key: 'publish.goLive',
        text: 'Go live',
      });
    });

    it('returns go live when errored', () => {
      const core = new PublishButtonCore();
      expect(core.getLabel(createState({ session: 'error' }))).toMatchObject({
        key: 'publish.goLive',
        text: 'Go live',
      });
    });

    it('returns stop stream when live', () => {
      const core = new PublishButtonCore();
      expect(core.getLabel(createState({ session: 'live' }))).toMatchObject({
        key: 'publish.stopStream',
        text: 'Stop stream',
      });
    });

    it('returns connecting while connecting', () => {
      const core = new PublishButtonCore();
      expect(core.getLabel(createState({ session: 'connecting' }))).toMatchObject({
        key: 'publish.connecting',
        text: 'Connecting…',
      });
    });

    it('returns stopping while stopping', () => {
      const core = new PublishButtonCore();
      expect(core.getLabel(createState({ session: 'stopping' }))).toMatchObject({
        key: 'publish.stopping',
        text: 'Stopping…',
      });
    });

    it('returns custom string label', () => {
      const core = new PublishButtonCore({ label: 'Broadcast' });
      expect(core.getLabel(createState())).toBe('Broadcast');
    });
  });

  describe('getAttrs', () => {
    it('returns aria-label', () => {
      const core = new PublishButtonCore();
      const attrs = core.getAttrs(createState({ session: 'idle' }));
      expect(attrs['aria-label']).toMatchObject({ key: 'publish.goLive', text: 'Go live' });
    });

    it('sets aria-disabled from derived disabled state', () => {
      const core = new PublishButtonCore();
      const attrs = core.getAttrs(createState({ disabled: true }));
      expect(attrs['aria-disabled']).toBe('true');
    });
  });

  describe('toggle', () => {
    it('publishes from idle', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publishState: 'idle' });

      await core.toggle(media);

      expect(media.publish).toHaveBeenCalled();
      expect(media.unpublish).not.toHaveBeenCalled();
    });

    it('publishes from error', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publishState: 'error' });

      await core.toggle(media);

      expect(media.publish).toHaveBeenCalled();
    });

    it('swallows publish rejections', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publish: vi.fn(async () => Promise.reject(new Error('failed'))) });

      await expect(core.toggle(media)).resolves.toBeUndefined();
    });

    it('unpublishes when live', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publishState: 'live' });

      await core.toggle(media);

      expect(media.unpublish).toHaveBeenCalled();
      expect(media.publish).not.toHaveBeenCalled();
    });

    it('unpublishes while connecting', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publishState: 'connecting' });

      await core.toggle(media);

      expect(media.unpublish).toHaveBeenCalled();
    });

    it('does nothing while stopping', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ publishState: 'stopping' });

      await core.toggle(media);

      expect(media.publish).not.toHaveBeenCalled();
      expect(media.unpublish).not.toHaveBeenCalled();
    });

    it('does not publish without active capture', async () => {
      const core = new PublishButtonCore();
      const media = createMediaState({ captureState: 'acquiring' });

      await core.toggle(media);

      expect(media.publish).not.toHaveBeenCalled();
    });

    it('does nothing when disabled', async () => {
      const core = new PublishButtonCore({ disabled: true });
      const media = createMediaState({ publishState: 'live' });

      await core.toggle(media);

      expect(media.unpublish).not.toHaveBeenCalled();
    });
  });
});
