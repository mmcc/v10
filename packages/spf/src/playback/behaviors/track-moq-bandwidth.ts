/**
 * **Feed MoQ object-arrival timing into `bandwidthState`.** Samples come
 * from push-delivery arrival gaps (each subscriber records its last
 * object's payload size and inter-arrival time) instead of HTTP chunk
 * timing — everything downstream, including `track-switching`'s
 * `rankByBandwidth` ABR, works unchanged.
 *
 * Push samples are much smaller than segment downloads, so the default
 * filter thresholds are MoQ-tuned (`DEFAULT_MOQ_BANDWIDTH_CONFIG`): a
 * video frame is a few KB arriving every few tens of milliseconds, which
 * the segment-tuned `minBytes`/`minDuration` defaults would discard
 * entirely. The EWMA smoothing absorbs the extra per-sample noise.
 *
 * Reads both per-type subscriber slots; each sample carries a `seq` so a
 * sample is consumed exactly once even though the effect re-fires on any
 * snapshot change.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import { effect } from '../../core/signals/effect';
import { peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import {
  type BandwidthConfig,
  type BandwidthState,
  DEFAULT_BANDWIDTH_CONFIG,
  sampleBandwidth,
} from '../../network/bandwidth-estimator';
import type { TrackSubscriberActor } from '../actors/track-subscriber';

export interface TrackMoqBandwidthState {
  bandwidthState?: BandwidthState;
}

export interface TrackMoqBandwidthContext {
  videoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
}

export interface TrackMoqBandwidthConfig {
  /** Estimator tuning; defaults to `DEFAULT_MOQ_BANDWIDTH_CONFIG`. */
  moqBandwidth?: Partial<BandwidthConfig>;
}

/** Segment-tuned defaults scaled down to per-object push samples. */
export const DEFAULT_MOQ_BANDWIDTH_CONFIG: BandwidthConfig = {
  ...DEFAULT_BANDWIDTH_CONFIG,
  minTotalBytes: 32_000,
  minBytes: 200,
  minDuration: 1,
};

function setupTrackMoqBandwidth({
  state,
  context,
  config,
}: {
  state: {
    bandwidthState: Signal<TrackMoqBandwidthState['bandwidthState']>;
  };
  context: {
    videoSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
    audioSubscriberActor: ReadonlySignal<TrackSubscriberActor | undefined>;
  };
  config?: TrackMoqBandwidthConfig;
}): () => void {
  const bandwidthConfig: BandwidthConfig = { ...DEFAULT_MOQ_BANDWIDTH_CONFIG, ...config?.moqBandwidth };

  // Last consumed sample sequence per actor. Keyed weakly so a destroyed
  // subscriber's bookkeeping goes with it.
  const consumedSeq = new WeakMap<TrackSubscriberActor, number>();

  const sampleFrom = (subscriber: TrackSubscriberActor | undefined): void => {
    if (!subscriber) return;
    const sample = subscriber.snapshot.get().context.lastSample;
    if (!sample || consumedSeq.get(subscriber) === sample.seq) return;
    consumedSeq.set(subscriber, sample.seq);
    if (sample.durationMs <= 0) return;
    const current = peek(state.bandwidthState);
    if (!current) return;
    state.bandwidthState.set(sampleBandwidth(current, sample.durationMs, sample.bytes, bandwidthConfig));
  };

  const disposals = [
    effect(() => sampleFrom(context.videoSubscriberActor.get())),
    effect(() => sampleFrom(context.audioSubscriberActor.get())),
  ];

  return () => {
    for (const dispose of disposals) dispose();
  };
}

export const trackMoqBandwidth = defineBehavior({
  stateKeys: ['bandwidthState'],
  contextKeys: ['videoSubscriberActor', 'audioSubscriberActor'],
  setup: setupTrackMoqBandwidth,
});
