import { describe, expect, it, vi } from 'vite-plus/test';

import { signal } from '../../../core/signals/primitives';
import type { MoqTrack } from '../../../media/moq/parse-catalog';
import type { BandwidthState } from '../../../network/bandwidth-estimator';
import type { TrackSubscriberActor, TrackSubscriberContext } from '../../actors/track-subscriber';
import { trackMoqBandwidth } from '../track-moq-bandwidth';

const INITIAL_BANDWIDTH_STATE: BandwidthState = {
  fastEstimate: 0,
  fastTotalWeight: 0,
  slowEstimate: 0,
  slowTotalWeight: 0,
  bytesSampled: 0,
};

function fakeSubscriber() {
  const snapshot = signal({
    value: 'active' as const,
    context: { status: 'active', hasDecodableFrame: false, frameCount: 0 } as TrackSubscriberContext,
  });
  let seq = 0;
  let totalBytes = 0;
  let totalDurationMs = 0;
  const subscriber: TrackSubscriberActor = {
    track: { id: 'live/video' } as MoqTrack,
    snapshot: snapshot as TrackSubscriberActor['snapshot'],
    peek: () => undefined,
    dequeue: () => undefined,
    skipToLatestGroup: () => 0,
    destroy: () => {},
  };
  const emitSample = (bytes: number, durationMs: number) => {
    seq++;
    totalBytes += bytes;
    totalDurationMs += durationMs;
    snapshot.set({
      value: 'active',
      context: { ...snapshot.get().context, arrivals: { seq, totalBytes, totalDurationMs } },
    });
  };
  const reemit = () => snapshot.set({ ...snapshot.get() });

  return { subscriber, emitSample, reemit };
}

function makeDeps(video?: TrackSubscriberActor, audio?: TrackSubscriberActor) {
  return {
    state: { bandwidthState: signal<BandwidthState | undefined>(INITIAL_BANDWIDTH_STATE) },
    context: {
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(video),
      audioSubscriberActor: signal<TrackSubscriberActor | undefined>(audio),
    },
  };
}

describe('trackMoqBandwidth', () => {
  it('feeds object-arrival samples into bandwidthState', async () => {
    const { subscriber, emitSample } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    const cleanup = trackMoqBandwidth.setup(deps);

    // 50 KB over 100 ms = 4 Mbps.
    emitSample(50_000, 100);
    await vi.waitFor(() => {
      const state = deps.state.bandwidthState.get()!;

      expect(state.bytesSampled).toBe(50_000);
      expect(state.fastEstimate).toBeGreaterThan(0);
    });

    cleanup();
  });

  it('consumes each sample exactly once across snapshot re-emits', async () => {
    const { subscriber, emitSample, reemit } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    const cleanup = trackMoqBandwidth.setup(deps);

    emitSample(50_000, 100);
    await vi.waitFor(() => expect(deps.state.bandwidthState.get()!.bytesSampled).toBe(50_000));

    // Snapshot notifies again (e.g. buffer drain) without a new sample.
    reemit();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.state.bandwidthState.get()!.bytesSampled).toBe(50_000);

    cleanup();
  });

  it('aggregates samples that land in one batch', async () => {
    const { subscriber, emitSample } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    const cleanup = trackMoqBandwidth.setup(deps);

    // Effects are microtask-batched: both arrivals collapse into one run
    // that only sees the final snapshot — the cumulative totals must still
    // account for every byte.
    emitSample(30_000, 50);
    emitSample(20_000, 50);
    await vi.waitFor(() => expect(deps.state.bandwidthState.get()!.bytesSampled).toBe(50_000));

    cleanup();
  });

  it('samples both video and audio subscribers', async () => {
    const video = fakeSubscriber();
    const audio = fakeSubscriber();
    const deps = makeDeps(video.subscriber, audio.subscriber);
    const cleanup = trackMoqBandwidth.setup(deps);

    video.emitSample(50_000, 100);
    audio.emitSample(1_000, 20);
    await vi.waitFor(() => expect(deps.state.bandwidthState.get()!.bytesSampled).toBe(51_000));

    cleanup();
  });

  it('ignores zero-duration samples (first arrival has no gap)', async () => {
    const { subscriber, emitSample } = fakeSubscriber();
    const deps = makeDeps(subscriber);
    const cleanup = trackMoqBandwidth.setup(deps);

    emitSample(50_000, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.state.bandwidthState.get()).toBe(INITIAL_BANDWIDTH_STATE);

    cleanup();
  });
});
