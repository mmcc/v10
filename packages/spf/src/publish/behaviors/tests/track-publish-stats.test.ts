import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorSnapshot } from '../../../core/actors/actor';
import { type Signal, signal } from '../../../core/signals/primitives';
import type { TrackPublisherActor, TrackPublisherCounters, TrackPublisherState } from '../../actors/track-publisher';
import type { PublishSessionActor, PublishSessionActorContext } from '../../session/publish-session';
import {
  type EncoderActorCounters,
  type EncoderActorState,
  type EncoderStatsSource,
  mergeVideoCounters,
  type TrackPublishStatsContext,
  type TrackPublishStatsState,
  trackPublishStats,
} from '../track-publish-stats';

const STATS_INTERVAL_MS = 20;

const ZERO_COUNTERS: EncoderActorCounters = {
  encodedFrames: 0,
  encodedBytes: 0,
  droppedFrames: 0,
  keyframes: 0,
  lastTimestampUs: Number.NaN,
};

function makeSource(counters: Partial<EncoderActorCounters> = {}): {
  source: EncoderStatsSource;
  snapshot: Signal<ActorSnapshot<EncoderActorState, EncoderActorCounters>>;
} {
  const snapshot = signal<ActorSnapshot<EncoderActorState, EncoderActorCounters>>({
    value: 'encoding',
    context: { ...ZERO_COUNTERS, ...counters },
  });
  return { source: { snapshot }, snapshot };
}

function advance(
  snapshot: Signal<ActorSnapshot<EncoderActorState, EncoderActorCounters>>,
  counters: Partial<EncoderActorCounters>
): void {
  const current = snapshot.get();
  snapshot.set({ ...current, context: { ...current.context, ...counters } });
}

const disposals: (() => void)[] = [];

function setupStats() {
  const state = { publishStats: signal<TrackPublishStatsState['publishStats']>(undefined) };
  const context = {
    cameraEncoderActor: signal<TrackPublishStatsContext['cameraEncoderActor']>(undefined),
    screenEncoderActor: signal<TrackPublishStatsContext['screenEncoderActor']>(undefined),
    audioEncoderActor: signal<TrackPublishStatsContext['audioEncoderActor']>(undefined),
    catalogTrackPublisher: signal<TrackPublishStatsContext['catalogTrackPublisher']>(undefined),
    videoTrackPublisher: signal<TrackPublishStatsContext['videoTrackPublisher']>(undefined),
    screenTrackPublisher: signal<TrackPublishStatsContext['screenTrackPublisher']>(undefined),
    audioTrackPublisher: signal<TrackPublishStatsContext['audioTrackPublisher']>(undefined),
    publishSessionActor: signal<TrackPublishStatsContext['publishSessionActor']>(undefined),
  };
  const reactor = trackPublishStats.setup({ state, context, config: { statsIntervalMs: STATS_INTERVAL_MS } });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

const ZERO_PUBLISHER_COUNTERS: TrackPublisherCounters = {
  openedGroups: 0,
  publishedGroups: 0,
  publishedObjects: 0,
  droppedGroups: 0,
  bytesSent: 0,
  queuedGroups: 0,
  lastTimestampUs: Number.NaN,
};

function makePublisher(counters: Partial<TrackPublisherCounters>): TrackPublisherActor {
  const snapshot = signal<ActorSnapshot<TrackPublisherState, TrackPublisherCounters>>({
    value: 'publishing',
    context: { ...ZERO_PUBLISHER_COUNTERS, ...counters },
  });
  return { snapshot, send: () => {}, destroy: () => {} };
}

function makeSessionActor(subscriberCount: number): PublishSessionActor {
  const snapshot = signal<ActorSnapshot<'active' | 'destroyed', PublishSessionActorContext>>({
    value: 'active',
    context: { status: 'live', publishedTracks: 1, subscriberCount },
  });
  return { snapshot, getAuthParameters: () => ({}), destroy: () => {} };
}

describe('mergeVideoCounters', () => {
  it('merges lastTimestampUs to the real value when only one side has emitted', () => {
    // NaN means "present but hasn't emitted yet" (the counters contract),
    // not "unknown" — it must not poison the other side's real reading.
    const emitting = { ...ZERO_COUNTERS, lastTimestampUs: 1_000 };
    const pending = { ...ZERO_COUNTERS, lastTimestampUs: Number.NaN };

    expect(mergeVideoCounters(emitting, pending)!.lastTimestampUs).toBe(1_000);
    expect(mergeVideoCounters(pending, emitting)!.lastTimestampUs).toBe(1_000);
  });

  it('merges two pre-first-chunk encoders to NaN', () => {
    const pending = { ...ZERO_COUNTERS, lastTimestampUs: Number.NaN };

    expect(mergeVideoCounters(pending, pending)!.lastTimestampUs).toBeNaN();
  });
});

describe('trackPublishStats', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('does not sample while no encoder actor exists', async () => {
    const { state } = setupStats();

    await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS * 3));
    expect(state.publishStats.get()).toBeUndefined();
  });

  it('samples encoder counters into rates and cumulative totals', async () => {
    const { state, context } = setupStats();
    const video = makeSource({ droppedFrames: 2, keyframes: 1 });
    const audio = makeSource({ droppedFrames: 1 });
    context.cameraEncoderActor.set(video.source);
    context.audioEncoderActor.set(audio.source);

    // Continuously moving counters (like a live encoder) so every sample
    // window sees a positive delta.
    const grow = setInterval(() => {
      const v = video.snapshot.get().context;
      advance(video.snapshot, { encodedFrames: v.encodedFrames + 3, encodedBytes: v.encodedBytes + 5_000 });
      const a = audio.snapshot.get().context;
      advance(audio.snapshot, { encodedFrames: a.encodedFrames + 5, encodedBytes: a.encodedBytes + 1_000 });
    }, 5);
    disposals.push(() => clearInterval(grow));

    let stats: TrackPublishStatsState['publishStats'];
    await vi.waitFor(() => {
      stats = state.publishStats.get();
      expect(stats?.encodedFps ?? 0).toBeGreaterThan(0);
    });
    expect(stats!.videoBitrate).toBeGreaterThan(0);
    expect(stats!.audioBitrate).toBeGreaterThan(0);
    expect(stats!.droppedFrames).toBe(3);
    expect(stats!.droppedGroups).toBe(0);
    // Transport facts come from the track publishers / session actor —
    // with neither present, nothing has been sent and no session exists.
    expect(stats!.bytesSent).toBe(0);
    expect(stats!.subscriberCount).toBeNaN();
  });

  it('aggregates camera + screen encoders into one video reading', async () => {
    const { state, context } = setupStats();
    const camera = makeSource({ encodedFrames: 0, encodedBytes: 0, droppedFrames: 2 });
    const screen = makeSource({ encodedFrames: 0, encodedBytes: 0, droppedFrames: 3 });
    context.cameraEncoderActor.set(camera.source);
    context.screenEncoderActor.set(screen.source);

    const grow = setInterval(() => {
      const c = camera.snapshot.get().context;
      advance(camera.snapshot, { encodedFrames: c.encodedFrames + 2, encodedBytes: c.encodedBytes + 3_000 });
      const s = screen.snapshot.get().context;
      advance(screen.snapshot, { encodedFrames: s.encodedFrames + 1, encodedBytes: s.encodedBytes + 1_000 });
    }, 5);
    disposals.push(() => clearInterval(grow));

    await vi.waitFor(() => {
      expect(state.publishStats.get()?.encodedFps ?? 0).toBeGreaterThan(0);
    });
    // droppedFrames is a cumulative sum, not a rate diff, so it is a
    // timing-independent proof that both legs' counters reach the merge —
    // dropping either leg (or averaging instead of summing) would read 2,
    // 3, or 2.5 here instead of 5.
    expect(state.publishStats.get()!.droppedFrames).toBe(5);
    // Screen alone tearing down must not drop the aggregate to unknown —
    // the camera leg still exists.
    context.screenEncoderActor.set(undefined);
    await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS * 2));
    expect(state.publishStats.get()!.videoBitrate).toBeGreaterThanOrEqual(0);
  });

  it('samples transport facts from the track publishers and the session actor', async () => {
    const { state, context } = setupStats();
    context.cameraEncoderActor.set(makeSource().source);
    context.catalogTrackPublisher.set(makePublisher({ bytesSent: 500 }));
    context.videoTrackPublisher.set(makePublisher({ droppedGroups: 2, bytesSent: 10_000 }));
    context.audioTrackPublisher.set(makePublisher({ droppedGroups: 1, bytesSent: 2_000 }));
    context.publishSessionActor.set(makeSessionActor(4));

    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });
    const stats = state.publishStats.get()!;
    expect(stats.droppedGroups).toBe(3);
    expect(stats.bytesSent).toBe(12_500);
    expect(stats.subscriberCount).toBe(4);

    // The session going away makes the subscriber count unknown again —
    // the sample re-reads the slots lazily every tick.
    context.publishSessionActor.set(undefined);
    context.videoTrackPublisher.set(undefined);
    await vi.waitFor(() => {
      expect(state.publishStats.get()!.subscriberCount).toBeNaN();
    });
    expect(state.publishStats.get()!.bytesSent).toBe(2_500);
  });

  it('derives rates from deltas between samples, not cumulative totals', async () => {
    const { state, context } = setupStats();
    const video = makeSource({ encodedFrames: 1_000, encodedBytes: 1_000_000 });
    context.cameraEncoderActor.set(video.source);

    // No counter movement after the baseline: rates must be zero even
    // though the cumulative totals are large.
    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });
    const stats = state.publishStats.get()!;
    expect(stats.encodedFps).toBe(0);
    expect(stats.videoBitrate).toBe(0);
    expect(stats.droppedFrames).toBe(0);
  });

  it('works video-only, reporting the audio rate as unknown', async () => {
    const { state, context } = setupStats();
    const video = makeSource({ encodedFrames: 10, encodedBytes: 5_000 });
    context.cameraEncoderActor.set(video.source);
    context.videoTrackPublisher.set(makePublisher({ bytesSent: 4_000 }));

    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });
    // NaN, not 0: a missing encoder is "unknown", while 0 means the leg
    // exists and produced nothing this window.
    expect(state.publishStats.get()!.audioBitrate).toBeNaN();
    expect(state.publishStats.get()!.bytesSent).toBe(4_000);
  });

  it('works audio-only, reporting the video rates as unknown', async () => {
    const { state, context } = setupStats();
    const audio = makeSource({ encodedFrames: 50, encodedBytes: 8_000 });
    context.audioEncoderActor.set(audio.source);

    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });
    // Zero here read as a stalled video encoder downstream and branded
    // every healthy audio-only session 'fair' connection quality.
    expect(state.publishStats.get()!.encodedFps).toBeNaN();
    expect(state.publishStats.get()!.videoBitrate).toBeNaN();
  });

  it('stops sampling and clears the stats when the encoders go away', async () => {
    const { state, context } = setupStats();
    const video = makeSource();
    context.cameraEncoderActor.set(video.source);
    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });

    context.cameraEncoderActor.set(undefined);
    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeUndefined();
    });

    // The interval is gone: nothing writes new samples afterwards.
    advance(video.snapshot, { encodedFrames: 99 });
    await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS * 3));
    expect(state.publishStats.get()).toBeUndefined();
  });

  it('clears the interval on reactor destroy', async () => {
    const { state, context, reactor } = setupStats();
    context.cameraEncoderActor.set(makeSource().source);
    await vi.waitFor(() => {
      expect(state.publishStats.get()).toBeDefined();
    });

    reactor.destroy();
    expect(state.publishStats.get()).toBeUndefined();
  });
});
