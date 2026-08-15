import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import type { AudioContextLike, AudioRendererActor } from '../../../actors/dom/audio-renderer';
import { createAudioRendererActor } from '../../../actors/dom/audio-renderer';
import type { VideoRendererActor } from '../../../actors/dom/video-renderer';
import { createVideoRendererActor } from '../../../actors/dom/video-renderer';
import type { TrackSubscriberActor } from '../../../actors/track-subscriber';
import type { PlayoutClockOwner } from '../../sync-latency';
import {
  type MoqRendererConfig,
  setupAudioRenderer,
  setupVideoRenderer,
  trackPlayoutHealth,
  trackPlayoutTime,
} from '../setup-moq-renderers';

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
      adaptiveTargetLatency: signal<number | undefined>(undefined),
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

  // Audio subscriptions can start long after video: an autoplay deferral
  // unlocks on first gesture, a sustained pause releases and rejoins. The
  // fresh buffer's edge can sit behind the running video self-clock, and
  // video only re-anchors on *forward* discontinuities — so an unclamped
  // anchor would freeze video until the new master clock caught up.
  it('never anchors audio behind a running video clock', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    // Audio's own edge would place the anchor at 9.5s.
    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    // Video is already presenting past that point: clamp forward to it.
    let videoClockUs = 11_000_000;
    context.videoRendererActor.set({
      snapshot: signal({ context: {} }),
      getClockTimeUs: () => videoClockUs,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);
    expect(getJoinAnchorUs!()).toBe(11_000_000);

    // A video clock behind audio's edge does not drag the anchor back.
    videoClockUs = 1_000_000;
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    reactor.destroy();
  });

  // The forward clamp assumes one shared timeline. A publisher that
  // re-anchors the audio timeline on a capture-source switch breaks that:
  // the video clock — still on the departed timeline — then sits past
  // everything the new timeline will deliver, and clamping onto it would
  // discard every arriving audio frame unheard.
  it('ignores a video clock a whole timeline step past the audio edge', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));
    const videoRenderer = (videoClockUs: number) =>
      ({
        snapshot: signal({ context: {} }),
        getClockTimeUs: () => videoClockUs,
        setTrack: vi.fn(),
        destroy: vi.fn(),
      }) as unknown as VideoRendererActor;

    // Same timeline: a video clock at/inside a step past the edge clamps.
    context.videoRendererActor.set(videoRenderer(11_000_000));
    expect(getJoinAnchorUs!()).toBe(11_000_000);

    // Foreign timeline: a video clock past the edge by more than a step is
    // ignored, and the audio edge anchors alone.
    context.videoRendererActor.set(videoRenderer(11_000_001));
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    reactor.destroy();
  });

  // The gap this exists for: the anchor is the renderer's drop threshold, so
  // returning `undefined` while the subscriber has published no edge means no trim
  // at all — audio behind the running video clock gets played rather than dropped.
  it('falls back to the running video clock when audio has buffered nothing', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { state, context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    state.targetLatency.set(1.5);
    // Video is running 1.5s behind its own live edge; audio has nothing yet.
    context.videoRendererActor.set({
      snapshot: signal({ context: {} }),
      getClockTimeUs: () => 8_500_000,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);
    context.audioSubscriberActor.set(makeFakeSubscriber(undefined));

    // The video clock rather than no threshold at all — audio inherits the target
    // the video leg already resolved (`newest − target`).
    expect(getJoinAnchorUs!()).toBe(8_500_000);

    // Once audio has its own frames, its edge takes over again.
    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));
    expect(getJoinAnchorUs!()).toBe(8_500_000); // still clamped forward: 8.5s > 10s − 1.5s
    context.audioSubscriberActor.set(makeFakeSubscriber(12_000_000));
    expect(getJoinAnchorUs!()).toBe(10_500_000);

    reactor.destroy();
  });

  it('places the anchor from audio alone while the video clock is silent', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000));
    // A video renderer that has not started (no decoded frame yet) reports
    // no clock, and audio-only playback has no video renderer at all.
    context.videoRendererActor.set({
      snapshot: signal({ context: {} }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    context.videoRendererActor.set(undefined);
    expect(getJoinAnchorUs!()).toBe(9_500_000);

    reactor.destroy();
  });

  // The clocks and the controller must aim at one number, so the
  // adaptive proposal has to reach the anchor too — with the same
  // precedence the controller applies.
  it('anchors on the adaptive target where the consumer set none', async () => {
    vi.mocked(createAudioRendererActor).mockImplementation(() => makeFakeAudioRenderer());
    const { state, context, reactor } = setupSetupAudioRenderer();

    await vi.waitFor(() => expect(createAudioRendererActor).toHaveBeenCalledTimes(1));
    const { getJoinAnchorUs } = vi.mocked(createAudioRendererActor).mock.calls[0]![0];

    context.audioSubscriberActor.set(makeFakeSubscriber(10_000_000, 3_000));
    // Catalog says 3s; the adaptive proposal outranks it.
    state.adaptiveTargetLatency.set(0.4);
    expect(getJoinAnchorUs!()).toBe(9_600_000);

    // …and an explicit consumer target outranks both.
    state.targetLatency.set(1);
    expect(getJoinAnchorUs!()).toBe(9_000_000);

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

describe('trackPlayoutTime', () => {
  function setupTrackPlayoutTime() {
    const state = {
      currentTime: signal<number | undefined>(undefined),
      playoutClockOwner: signal<PlayoutClockOwner | undefined>(undefined),
    };
    const context = {
      audioRendererActor: signal<AudioRendererActor | undefined>(undefined),
      videoRendererActor: signal<VideoRendererActor | undefined>(undefined),
    };
    const cleanup = trackPlayoutTime.setup({ state, context });
    return { state, context, cleanup };
  }

  // `currentTime` is what the media-element facade derives readiness from
  // *and* what `syncLatency` measures its latency against. With no audio
  // the master clock never advances, so without this fallback a video-only
  // catalog renders fine but stays at HAVE_METADATA — and the latency
  // controller never gets a setpoint.
  it('publishes the video renderer timestamp when there is no audio clock', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();
    expect(state.currentTime.get()).toBeUndefined();

    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 2_500_000 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(2.5));

    cleanup();
  });

  it('prefers the audio master clock over the video fallback', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();

    context.audioRendererActor.set({
      snapshot: signal({ context: {} }),
      setTrack: vi.fn(),
      getClockTimeUs: () => 4_000_000,
      destroy: vi.fn(),
    } as unknown as AudioRendererActor);
    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 9_000_000 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(4));

    cleanup();
  });

  // The whole point of publishing the owner: an audio renderer can exist,
  // with a subscriber and a filling buffer, and still not be the clock —
  // `getClockTimeUs()` is undefined until it has scheduled something. Only
  // this interval can see that, so it says so rather than leaving
  // `syncLatency` to guess from the subscribers and measure across two
  // timebases for the whole of the join window.
  it('names the clock the position came from, and follows the handover', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();
    expect(state.playoutClockOwner.get()).toBeUndefined();

    let audioClockUs: number | undefined;
    context.audioRendererActor.set({
      snapshot: signal({ context: {} }),
      setTrack: vi.fn(),
      getClockTimeUs: () => audioClockUs,
      destroy: vi.fn(),
    } as unknown as AudioRendererActor);
    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 2_000_000 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    // Audio renderer present, audio not scheduled: video is the clock.
    await vi.waitFor(() => expect(state.currentTime.get()).toBe(2));
    expect(state.playoutClockOwner.get()).toBe('video');

    // The schedule starts, and the owner moves with the position.
    audioClockUs = 9_000_000;
    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBe('audio'));
    expect(state.currentTime.get()).toBe(9);

    cleanup();
  });

  // The handover has a third state, and it is the one the owner is *for*.
  // Both clocks can stop producing a position at once — an audio track switch
  // runs `setTrack`, which closes the decoder and empties the schedule, so
  // `getClockTimeUs()` returns undefined until the replacement has been
  // scheduled; a video renderer replaced along with it has presented nothing
  // yet. Neither branch below runs, and a name left latched on the clock that
  // stopped is worse than no name: `syncLatency` measures the delivery edge of
  // whichever track the owner names, so the refilling replacement gets
  // controlled against a frozen position and reads further behind every
  // evaluation.
  it('drops the owner when neither clock is producing a position', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();

    let audioClockUs: number | undefined = 9_000_000;
    context.audioRendererActor.set({
      snapshot: signal({ context: {} }),
      setTrack: vi.fn(),
      getClockTimeUs: () => audioClockUs,
      destroy: vi.fn(),
    } as unknown as AudioRendererActor);

    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBe('audio'));
    expect(state.currentTime.get()).toBe(9);

    // The schedule is emptied and there is no video renderer to fall back to.
    audioClockUs = undefined;
    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBeUndefined());

    // The *position* is deliberately left where it was. `currentTime` is also
    // the media element's `currentTime` (which reads `undefined` as 0) and the
    // track-handoff promotion gate's due-time reference (which reads it as
    // "promote immediately"), so clearing it would send a position of zero to
    // the facade and open a gate that exists to stay shut. The owner is the
    // signal that says the position is no longer live.
    expect(state.currentTime.get()).toBe(9);

    cleanup();
  });

  // The video flavor of the same state, and the one a video-only broadcast
  // reaches on every track change: `setTrack` clears the video renderer's
  // `lastPresentedTimestampUs` (it named a frame from the departed track), so
  // the fallback below produces nothing until the replacement presents. With
  // no audio clock to hand over to there is no owner at all — which is what
  // stands `syncLatency` down, instead of it measuring the refilling
  // replacement's edge against the position the departed track stopped at.
  it('drops the video owner when the video renderer stops presenting', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();

    let presentedUs: number | undefined = 5_000_000;
    context.videoRendererActor.set({
      get snapshot() {
        return signal({ context: { lastPresentedTimestampUs: presentedUs } });
      },
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBe('video'));
    expect(state.currentTime.get()).toBe(5);

    // The controlled track is replaced: decoder closed, decoded queue
    // dropped, keyframe gate re-armed, and no position published until the
    // replacement's first frame is presented.
    presentedUs = undefined;
    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBeUndefined());
    // The position is left where it was, for the facade and the promotion gate.
    expect(state.currentTime.get()).toBe(5);

    // The replacement presents: the owner comes back on its position, not the
    // departed track's.
    presentedUs = 6_000_000;
    await vi.waitFor(() => expect(state.playoutClockOwner.get()).toBe('video'));
    expect(state.currentTime.get()).toBe(6);

    cleanup();
  });

  // The reason this is its own behavior: gated on the AudioContext, the
  // clock would go silent in exactly the video-only case it exists for.
  it('runs with no AudioContext and no audio renderer', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();

    context.videoRendererActor.set({
      snapshot: signal({ context: { lastPresentedTimestampUs: 7_000_000 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(7));
    expect(context.audioRendererActor.get()).toBeUndefined();

    cleanup();
  });

  it('stops publishing after cleanup', async () => {
    const { state, context, cleanup } = setupTrackPlayoutTime();
    let presentedUs = 1_000_000;
    context.videoRendererActor.set({
      get snapshot() {
        return signal({ context: { lastPresentedTimestampUs: presentedUs } });
      },
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.currentTime.get()).toBe(1));
    cleanup();

    presentedUs = 5_000_000;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(state.currentTime.get()).toBe(1);
  });
});

describe('setupVideoRenderer', () => {
  function setupSetupVideoRenderer(config?: MoqRendererConfig) {
    const state = {
      playoutRate: signal<number | undefined>(undefined),
      targetLatency: signal<number | undefined>(undefined),
      adaptiveTargetLatency: signal<number | undefined>(undefined),
      paused: signal<boolean | undefined>(undefined),
    };
    const context = {
      renderSurface: signal<HTMLCanvasElement | OffscreenCanvas | undefined>(document.createElement('canvas')),
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      audioRendererActor: signal<AudioRendererActor | undefined>(undefined),
      videoRendererActor: signal<VideoRendererActor | undefined>(undefined),
    };
    const reactor = setupVideoRenderer.setup({ state, context, config });
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

  it('aims the self-clock at the live edge of the video jitter buffer', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { context, reactor } = setupSetupVideoRenderer();

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getTargetClockUs } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    expect(getTargetClockUs!()).toBeUndefined();
    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000));
    expect(getTargetClockUs!()).toBe(3_500_000);

    // Re-read as the edge advances: this seam is the self-clock's
    // continuous target, not a value sampled once at join.
    context.videoSubscriberActor.set(makeFakeSubscriber(6_000_000));
    expect(getTargetClockUs!()).toBe(5_500_000);

    reactor.destroy();
  });

  it('passes the configured slew bounds to the renderer', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { reactor } = setupSetupVideoRenderer({ latency: { clockSlewRate: 0.1, clockSlewTolerance: 0.02 } });

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const options = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    expect(options.clockSlewRate).toBe(0.1);
    expect(options.clockSlewToleranceUs).toBe(20_000);

    reactor.destroy();
  });

  it('aims the self-clock at the adaptive target where the consumer set none', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { state, context, reactor } = setupSetupVideoRenderer();

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getTargetClockUs } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000));
    state.adaptiveTargetLatency.set(0.2);
    expect(getTargetClockUs!()).toBe(3_800_000);

    state.targetLatency.set(1);
    expect(getTargetClockUs!()).toBe(3_000_000);

    reactor.destroy();
  });

  // The self-clock writes every slew correction back as its own anchor, so
  // a single `NaN` target clock leaves the clock `NaN` for the life of the
  // track and no frame is ever due again. A consumer target that cannot be
  // held has to be treated as no target rather than forwarded.
  it('keeps the target clock finite when the consumer target is unusable', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { state, context, reactor } = setupSetupVideoRenderer();

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getTargetClockUs } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000, 200));
    state.targetLatency.set(Number.NaN);
    // The catalog's 200ms, not NaN: an unusable statement is no statement.
    expect(getTargetClockUs!()).toBe(3_800_000);

    // Negative would anchor *ahead* of the delivery edge, where the
    // renderer drop-lates everything it holds.
    state.targetLatency.set(-1);
    expect(getTargetClockUs!()).toBe(3_800_000);

    state.targetLatency.set(undefined);
    state.adaptiveTargetLatency.set(Number.NaN);
    expect(getTargetClockUs!()).toBe(3_800_000);

    reactor.destroy();
  });

  // The last layer of the chain, and the one that used to get through: with
  // nothing else stating a target there is nothing below a config default to
  // fall through to, so `resolveLatencyControlConfig` replaces it before the
  // renderer ever sees it.
  it('keeps the target clock finite when the configured default is unusable', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { context, reactor } = setupSetupVideoRenderer({ latency: { defaultTargetLatency: Number.NaN } });

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    const { getTargetClockUs } = vi.mocked(createVideoRendererActor).mock.calls[0]![0];

    // No consumer target, no catalog target: the built-in 0.5s default.
    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000));
    expect(getTargetClockUs!()).toBe(3_500_000);

    reactor.destroy();
  });

  it('supplies no target clock with joinAtEdge off', async () => {
    vi.mocked(createVideoRendererActor).mockImplementation(() => makeFakeVideoRenderer());
    const { context, reactor } = setupSetupVideoRenderer({ latency: { joinAtEdge: false } });

    await vi.waitFor(() => expect(createVideoRendererActor).toHaveBeenCalledTimes(1));
    context.videoSubscriberActor.set(makeFakeSubscriber(4_000_000));

    // No target at all, so the self-clock keeps its first-decoded-frame
    // anchor and never slews.
    expect(vi.mocked(createVideoRendererActor).mock.calls[0]![0].getTargetClockUs).toBeUndefined();

    reactor.destroy();
  });
});

describe('trackPlayoutHealth', () => {
  function setupTrackPlayoutHealth() {
    const state = {
      framesDropped: signal<number | undefined>(undefined),
      audioUnderruns: signal<number | undefined>(undefined),
    };
    const context = {
      audioRendererActor: signal<AudioRendererActor | undefined>(undefined),
      videoRendererActor: signal<VideoRendererActor | undefined>(undefined),
    };
    const cleanup = trackPlayoutHealth.setup({ state, context });
    return { state, context, cleanup };
  }

  // Both counters lived inside the renderer actors and were readable from
  // nowhere. They are the cost half of any latency decision — a lower
  // target is only good news next to "and nothing started dropping".
  it('publishes the renderers cost counters', async () => {
    const { state, context, cleanup } = setupTrackPlayoutHealth();

    context.videoRendererActor.set({
      snapshot: signal({ context: { framesDropped: 7 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);
    context.audioRendererActor.set({
      snapshot: signal({ context: { underruns: 2 } }),
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as AudioRendererActor);

    await vi.waitFor(() => expect(state.framesDropped.get()).toBe(7));
    expect(state.audioUnderruns.get()).toBe(2);

    cleanup();
  });

  // Instrumentation is not gated on adaptation being on: an A/B whose
  // control arm reports nothing cannot be read.
  it('runs with no renderers at all and publishes nothing', async () => {
    const { state, cleanup } = setupTrackPlayoutHealth();

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(state.framesDropped.get()).toBeUndefined();
    expect(state.audioUnderruns.get()).toBeUndefined();

    cleanup();
  });

  it('stops publishing after cleanup', async () => {
    const { state, context, cleanup } = setupTrackPlayoutHealth();
    let framesDropped = 1;
    context.videoRendererActor.set({
      get snapshot() {
        return signal({ context: { framesDropped } });
      },
      getClockTimeUs: () => undefined,
      setTrack: vi.fn(),
      destroy: vi.fn(),
    } as unknown as VideoRendererActor);

    await vi.waitFor(() => expect(state.framesDropped.get()).toBe(1));
    cleanup();

    framesDropped = 9;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(state.framesDropped.get()).toBe(1);
  });
});
