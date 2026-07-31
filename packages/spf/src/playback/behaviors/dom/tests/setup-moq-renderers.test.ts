import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import type { AudioContextLike, AudioRendererActor } from '../../../actors/dom/audio-renderer';
import { createAudioRendererActor } from '../../../actors/dom/audio-renderer';
import type { VideoRendererActor } from '../../../actors/dom/video-renderer';
import { createVideoRendererActor } from '../../../actors/dom/video-renderer';
import type { TrackSubscriberActor } from '../../../actors/track-subscriber';
import { type MoqRendererConfig, setupAudioRenderer, setupVideoRenderer } from '../setup-moq-renderers';

// Mock the actor factories: these tests assert the behaviors' wiring (the
// options each factory receives), not the renderers themselves.
vi.mock('../../../actors/dom/audio-renderer', () => ({
  createAudioRendererActor: vi.fn(),
}));
vi.mock('../../../actors/dom/video-renderer', () => ({
  createVideoRendererActor: vi.fn(),
}));

function makeFakeAudioRenderer(): AudioRendererActor {
  return {
    snapshot: signal({ context: {} }),
    setTrack: vi.fn(),
    getClockTimeUs: vi.fn(() => undefined),
    destroy: vi.fn(),
  } as unknown as AudioRendererActor;
}

function makeFakeVideoRenderer(): VideoRendererActor {
  return {
    snapshot: signal({ context: {} }),
    setTrack: vi.fn(),
    destroy: vi.fn(),
  } as unknown as VideoRendererActor;
}

/** Subscriber whose jitter buffer holds frames up to `newestTimestampUs`. */
function makeFakeSubscriber(newestTimestampUs: number | undefined, catalogTargetMs?: number): TrackSubscriberActor {
  return {
    track: { moq: { targetLatency: catalogTargetMs } },
    snapshot: signal({ context: { newestTimestampUs } }),
    peek: () => undefined,
    dequeue: () => undefined,
    skipToLatestGroup: () => 0,
    destroy: vi.fn(),
  } as unknown as TrackSubscriberActor;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('setupAudioRenderer', () => {
  function setupSetupAudioRenderer(config?: MoqRendererConfig) {
    const state = {
      playoutRate: signal<number | undefined>(undefined),
      targetLatency: signal<number | undefined>(undefined),
      currentTime: signal<number | undefined>(undefined),
    };
    const context = {
      audioContext: signal<AudioContextLike | undefined>({} as AudioContextLike),
      audioSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      audioRendererActor: signal<AudioRendererActor | undefined>(undefined),
      videoRendererActor: signal<VideoRendererActor | undefined>(undefined),
    };
    const reactor = setupAudioRenderer.setup({ state, context, config });
    return { state, context, reactor };
  }

  it('keeps getPlaybackRate at the playout rate (pause is handled by AudioContext suspension)', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { state, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getPlaybackRate } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    expect(getPlaybackRate!()).toBe(1);
    // Rate must stay positive even through a pause: a rate of 0 would
    // schedule an infinite clock segment (duration ÷ 0) and dead sources.
    state.playoutRate.set(1.05);
    expect(getPlaybackRate!()).toBe(1.05);

    reactor.destroy();
  });

  // `currentTime` is the only thing the media-element facade derives
  // readiness from. With no audio the master clock never advances, so
  // without this fallback a video-only catalog renders fine but stays at
  // HAVE_METADATA and the shell buffers forever.
  it('publishes the video renderer timestamp as currentTime when there is no audio clock', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { state, context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    expect(state.currentTime.get()).toBeUndefined();

    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 2_500_000 } }),
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(2.5));

    reactor.destroy();
  });

  it('prefers the audio master clock over the video fallback', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(
      () =>
        ({
          snapshot: signal({ context: {} }),
          setTrack: vi.fn(),
          getClockTimeUs: vi.fn(() => 4_000_000),
          destroy: vi.fn(),
        }) as unknown as AudioRendererActor
    );
    const { state, context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 9_000_000 } }),
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(4));

    reactor.destroy();
  });

  it('anchors the renderer at the live edge of its own jitter buffer', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { state, context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    // No subscriber, or one that has buffered nothing: no anchor to place.
    expect(getJoinAnchorUs!()).toBeUndefined();
    context.audioSubscriberActor.set(makeFakeSubscriber(undefined));
    expect(getJoinAnchorUs!()).toBeUndefined();

    // The default 0.5s target behind the newest buffered frame.
    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    // Consumer input wins over the default…
    state.targetLatency.set(2);
    expect(getJoinAnchorUs!()).toBe(8_000_000);

    // …and the catalog target only fills in for an unset consumer value.
    state.targetLatency.set(undefined);
    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000, 3_000));
    expect(getJoinAnchorUs!()).toBe(7_000_000);

    reactor.destroy();
  });

  it('supplies no anchor with joinAtEdge off', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { context, reactor } = setupSetupAudioRenderer({ latency: { joinAtEdge: false } });

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));

    // Not "an anchor that happens to be at the head" — no anchor at all, so
    // the renderer keeps its oldest-buffered-frame behavior verbatim.
    expect(vi.mocked(createAudioRendererActor).mock.calls[0]![0].getJoinAnchorUs).toBeUndefined();

    reactor.destroy();
  });
});

describe('setupVideoRenderer', () => {
  function setupSetupVideoRenderer() {
    const state = {
      playoutRate: signal<number | undefined>(undefined),
      targetLatency: signal<number | undefined>(undefined),
      paused: signal<boolean | undefined>(undefined),
    };
    const context = {
      renderSurface: signal<HTMLCanvasElement | OffscreenCanvas | undefined>(document.createElement('canvas')),
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      audioRendererActor: signal<AudioRendererActor | undefined>(undefined),
      videoRendererActor: signal<VideoRendererActor | undefined>(undefined),
    };
    const reactor = setupVideoRenderer.setup({ state, context });
    return { state, context, reactor };
  }

  it('gates getPlaybackRate to 0 while paused', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { state, reactor } = setupSetupVideoRenderer();

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getPlaybackRate } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    expect(getPlaybackRate!()).toBe(1);
    state.playoutRate.set(0.95);
    expect(getPlaybackRate!()).toBe(0.95);

    state.paused.set(true);
    expect(getPlaybackRate!()).toBe(0);

    state.paused.set(false);
    expect(getPlaybackRate!()).toBe(0.95);

    reactor.destroy();
  });

  it('anchors the self-clock at the live edge of the video jitter buffer', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { context, reactor } = setupSetupVideoRenderer();

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    expect(getJoinAnchorUs!()).toBeUndefined();
    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000));
    expect(getJoinAnchorUs!()).toBe(3_500_000);

    reactor.destroy();
  });
});
