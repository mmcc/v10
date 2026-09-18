import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import {
  type AcquireScreenShareContext,
  type AcquireScreenShareState,
  acquireScreenShare,
} from '../acquire-capture-source';

function makeState(initial: AcquireScreenShareState = {}): StateSignals<AcquireScreenShareState> {
  return {
    screenShareActive: signal(initial.screenShareActive ?? false),
    screenShareState: signal(initial.screenShareState ?? 'idle'),
    screenTracks: signal(initial.screenTracks),
    publishError: signal(initial.publishError),
  };
}

function makeContext(initial: AcquireScreenShareContext = {}): ContextSignals<AcquireScreenShareContext> {
  return {
    screenStream: signal(initial.screenStream),
  };
}

const disposals: (() => void)[] = [];

function setupAcquire() {
  const state = makeState();
  const context = makeContext();
  const reactor = acquireScreenShare.setup({ state, context });

  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

class FakeMediaStreamTrack extends EventTarget {
  enabled = true;
  readonly kind: 'video' | 'audio';
  readonly stop = vi.fn();
  readonly #settings: MediaTrackSettings;

  constructor(kind: 'video' | 'audio', settings: MediaTrackSettings = {}) {
    super();
    this.kind = kind;
    this.#settings = settings;
  }

  getSettings(): MediaTrackSettings {
    return this.#settings;
  }
}

class FakeMediaStream {
  readonly #tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[]) {
    this.#tracks = tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.#tracks];
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'video');
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.#tracks.filter((track) => track.kind === 'audio');
  }
}

const asStream = (stream: FakeMediaStream) => stream as unknown as MediaStream;

describe('acquireScreenShare', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('acquires the screen video-only — never requests system audio', async () => {
    const displayStream = new FakeMediaStream([new FakeMediaStreamTrack('video', { width: 1920, height: 1080 })]);
    const getDisplayMedia = vi
      .spyOn(navigator.mediaDevices, 'getDisplayMedia')
      .mockResolvedValue(asStream(displayStream));
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const { state, context } = setupAcquire();

    state.screenShareActive.set(true);

    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('active');
    });
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    // The mic is a separate, always-independent pipeline — screen share
    // never merges it in (the fix for the confirmed mic-reselection defect).
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(context.screenStream.get()).toBe(asStream(displayStream));
    expect(state.screenTracks.get()?.width).toBe(1920);

    // Screen content favors legibility — the hint steers browser encoding
    // heuristics (design record, "Encoder budget & degradation").
    for (const track of displayStream.getVideoTracks()) {
      expect((track as unknown as { contentHint?: string }).contentHint).toBe('detail');
    }
  });

  it('releases the screen stream when deactivated', async () => {
    const displayStream = new FakeMediaStream([new FakeMediaStreamTrack('video')]);

    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    const { state, context } = setupAcquire();

    state.screenShareActive.set(true);
    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('active');
    });

    const acquired = displayStream.getTracks();

    state.screenShareActive.set(false);

    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('idle');
      expect(context.screenStream.get()).toBeUndefined();
    });

    for (const track of acquired) expect(track.stop).toHaveBeenCalled();
  });

  it('maps NotAllowedError (picker dismissed) to denied and consumes the intent', async () => {
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockRejectedValue(
      new DOMException('Permission denied', 'NotAllowedError')
    );
    const { state, context } = setupAcquire();

    state.screenShareActive.set(true);

    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('denied');
    });
    expect(state.publishError.get()).toBeUndefined();
    expect(context.screenStream.get()).toBeUndefined();
    // A dismissed picker consumes the intent — anything gating on
    // screenShareActive (the share button's pressed look, the mic's
    // OR-gate) must see the share is not happening.
    await vi.waitFor(() => {
      expect(state.screenShareActive.get()).toBe(false);
    });
    expect(state.screenShareState.get()).toBe('denied');
  });

  it('releases and lands in ended when the browser-UI "Stop sharing" ends the track', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const displayStream = new FakeMediaStream([videoTrack]);

    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    const { state, context } = setupAcquire();

    state.screenShareActive.set(true);
    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('active');
    });

    videoTrack.dispatchEvent(new Event('ended'));

    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('ended');
    });
    expect(context.screenStream.get()).toBeUndefined();
    expect(videoTrack.stop).toHaveBeenCalled();
    // Browser-native "Stop sharing" consumes the intent: one click
    // re-shares, and the mic's OR-gate collapses when this was the only
    // active video source.
    await vi.waitFor(() => {
      expect(state.screenShareActive.get()).toBe(false);
    });
    expect(state.screenShareState.get()).toBe('ended');
  });

  it('maps a terminal acquisition failure to a capture error and consumes the intent', async () => {
    const failure = Object.assign(new Error('display busy'), { name: 'NotReadableError' });

    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockRejectedValue(failure);
    const { state, context } = setupAcquire();

    state.screenShareActive.set(true);

    await vi.waitFor(() => {
      expect(state.publishError.get()).toMatchObject({ code: 'capture', cause: failure });
    });
    expect(state.screenShareState.get()).toBe('idle');
    expect(context.screenStream.get()).toBeUndefined();
    expect(state.screenTracks.get()).toBeUndefined();
    // Failed pipelines consume the intent like denied/ended — the mic's
    // OR-gate must not stay hot behind a share that never started.
    await vi.waitFor(() => {
      expect(state.screenShareActive.get()).toBe(false);
    });
  });

  it('stops the owned stream on destroy', async () => {
    const videoTrack = new FakeMediaStreamTrack('video');
    const displayStream = new FakeMediaStream([videoTrack]);

    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(asStream(displayStream));
    const { state, context, reactor } = setupAcquire();

    state.screenShareActive.set(true);
    await vi.waitFor(() => {
      expect(state.screenShareState.get()).toBe('active');
    });

    reactor.destroy();

    expect(videoTrack.stop).toHaveBeenCalled();
    expect(context.screenStream.get()).toBeUndefined();
  });
});
