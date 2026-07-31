import { describe, expect, it, vi } from 'vitest';
import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import { type ApplyTrackTogglesContext, type ApplyTrackTogglesState, applyTrackToggles } from '../apply-track-toggles';

class FakeMediaStreamTrack {
  enabled = true;
  readonly kind: 'video' | 'audio';

  constructor(kind: 'video' | 'audio') {
    this.kind = kind;
  }
}

class FakeMediaStream {
  readonly #tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[]) {
    this.#tracks = tracks;
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'video');
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'audio');
  }
}

const asStream = (stream: FakeMediaStream) => stream as unknown as MediaStream;

function setupToggles(initialState: ApplyTrackTogglesState = {}, initialContext: ApplyTrackTogglesContext = {}) {
  const state: StateSignals<ApplyTrackTogglesState> = {
    cameraMuted: signal(initialState.cameraMuted ?? false),
    micMuted: signal(initialState.micMuted ?? false),
  };
  const context: ContextSignals<ApplyTrackTogglesContext> = {
    captureStream: signal(initialContext.captureStream),
  };
  const cleanup = applyTrackToggles.setup({ state, context });
  return { state, context, cleanup };
}

describe('applyTrackToggles', () => {
  it('flips track.enabled when the mute flags change', async () => {
    const video = new FakeMediaStreamTrack('video');
    const audio = new FakeMediaStreamTrack('audio');
    const { state, context, cleanup } = setupToggles();
    context.captureStream.set(asStream(new FakeMediaStream([video, audio])));

    state.cameraMuted.set(true);
    await vi.waitFor(() => {
      expect(video.enabled).toBe(false);
    });
    expect(audio.enabled).toBe(true);

    state.micMuted.set(true);
    await vi.waitFor(() => {
      expect(audio.enabled).toBe(false);
    });

    state.cameraMuted.set(false);
    await vi.waitFor(() => {
      expect(video.enabled).toBe(true);
    });
    expect(audio.enabled).toBe(false);

    cleanup();
  });

  it('applies the current mute state to a newly acquired stream', async () => {
    const video = new FakeMediaStreamTrack('video');
    const audio = new FakeMediaStreamTrack('audio');
    const { context, cleanup } = setupToggles({ cameraMuted: true, micMuted: false });

    context.captureStream.set(asStream(new FakeMediaStream([video, audio])));

    await vi.waitFor(() => {
      expect(video.enabled).toBe(false);
    });
    expect(audio.enabled).toBe(true);

    cleanup();
  });
});
