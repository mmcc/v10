/**
 * **Sample the publish pipeline into `state.publishStats`.** While an
 * encoder actor exists, an interval owned by this behavior (~1 Hz) diffs
 * snapshot counters into rates — `encodedFps` from frame-count deltas,
 * `videoBitrate` / `audioBitrate` from byte deltas ×8 — alongside the
 * cumulative encode total (`droppedFrames`). Camera and screen are
 * aggregated into one `videoBitrate` / `encodedFps` reading (their
 * counters are summed before the rate diff) per the multi-source design
 * record's "Surface" decision — v1 has no per-track stats breakout. The
 * transport-side facts come from the track publishers and the session
 * actor when those exist: `droppedGroups` and `bytesSent` sum the
 * per-track publisher counters (bytes actually handed to the transport —
 * 0 while no session publishes), and `subscriberCount` reads the session
 * actor's live subscription count (`NaN` while no session exists —
 * genuinely unknown). The interval is cleared and the stats slot reset on
 * state exit / teardown; nothing samples while no encoder exists.
 *
 * DOM-free: the encoder actors are DOM-bound (WebCodecs), so this
 * behavior reads them through the structural `EncoderStatsSource` view
 * below (its shape mirrors `publish/actors/dom/encoder-actor.ts` — the
 * engine's context typing enforces that the two stay identical). The
 * track publishers and session actor are DOM-free, so their types import
 * directly; all transport slots are read lazily and untracked (`peek`)
 * inside each sample so churn never rebuilds the interval.
 *
 * Sole writer of `state.publishStats`.
 */
import type { ActorSnapshot } from '../../core/actors/actor';
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import type { TrackPublisherActor, TrackPublisherCounters } from '../actors/track-publisher';
import type { PublishSessionActor } from '../session/publish-session';

/** Aggregated pipeline health counters, sampled at a low frequency. */
export interface PublishStatsFacts {
  /** Encoded video frames per second; `NaN` while no video encoder exists. */
  encodedFps: number;
  /** Encoded video bits per second; `NaN` while no video encoder exists. */
  videoBitrate: number;
  /** Encoded audio bits per second; `NaN` while no audio encoder exists. */
  audioBitrate: number;
  /** Frames the encoders dropped (queue overflow), cumulative. */
  droppedFrames: number;
  /** Groups the track publishers reset under backpressure, cumulative. */
  droppedGroups: number;
  /** Payload bytes handed to the transport across all published tracks. */
  bytesSent: number;
  /** Live inbound subscriptions; `NaN` while no session exists. */
  subscriberCount: number;
}

/**
 * Cumulative encode counters as exposed on an encoder actor snapshot.
 * Structural mirror of `publish/actors/dom/encoder-actor.ts`'s
 * `EncoderActorCounters` (DOM-bound, so not importable here) — the two
 * must stay identical.
 */
export interface EncoderActorCounters {
  encodedFrames: number;
  encodedBytes: number;
  droppedFrames: number;
  keyframes: number;
  lastTimestampUs: number;
}

/** Mirror of the encoder actors' state union — keep identical. */
export type EncoderActorState = 'unconfigured' | 'encoding' | 'closed' | 'destroyed';

/** DOM-free structural view of an encoder actor: just its snapshot. */
export interface EncoderStatsSource {
  snapshot: ReadonlySignal<ActorSnapshot<EncoderActorState, EncoderActorCounters>>;
}

export interface TrackPublishStatsState {
  publishStats?: PublishStatsFacts;
}

export interface TrackPublishStatsContext {
  cameraEncoderActor?: EncoderStatsSource | undefined;
  screenEncoderActor?: EncoderStatsSource | undefined;
  audioEncoderActor?: EncoderStatsSource | undefined;
  catalogTrackPublisher?: TrackPublisherActor | undefined;
  videoTrackPublisher?: TrackPublisherActor | undefined;
  screenTrackPublisher?: TrackPublisherActor | undefined;
  audioTrackPublisher?: TrackPublisherActor | undefined;
  publishSessionActor?: PublishSessionActor | undefined;
}

export interface TrackPublishStatsConfig {
  /** Sampling period; ~1 Hz default. */
  statsIntervalMs?: number;
}

export const DEFAULT_STATS_INTERVAL_MS = 1000;

type TrackPublishStatsFsmState = 'no-encoders' | 'sampling';

/** Untracked counter read — sampling must not retrigger reactively. */
function readCounters(source: EncoderStatsSource | undefined): EncoderActorCounters | undefined {
  return source === undefined ? undefined : peek(source.snapshot).context;
}

function perSecond(
  now: EncoderActorCounters | undefined,
  last: EncoderActorCounters | undefined,
  field: 'encodedFrames' | 'encodedBytes',
  dtSec: number
): number {
  // A missing encoder is "unknown" (NaN per the stats contract), not a
  // zero rate: quality derivation reads 0 as a stalled encoder, which
  // branded every audio-only session 'fair'.
  if (now === undefined || last === undefined) return Number.NaN;
  if (dtSec <= 0) return 0;
  return (now[field] - last[field]) / dtSec;
}

/**
 * Merge two `lastTimestampUs` readings. NaN means "present but hasn't
 * emitted yet" (per the counters contract), not "unknown" — `Math.max`
 * alone would let one spinning-up encoder's NaN poison the other side's
 * real value. Treat NaN the same as absent, and only fall through to NaN
 * when neither side has ever emitted.
 */
function mergeLastTimestampUs(camera: number | undefined, screen: number | undefined): number {
  const cameraReal = camera !== undefined && !Number.isNaN(camera) ? camera : undefined;
  const screenReal = screen !== undefined && !Number.isNaN(screen) ? screen : undefined;
  if (cameraReal === undefined && screenReal === undefined) return Number.NaN;
  return Math.max(cameraReal ?? -Infinity, screenReal ?? -Infinity);
}

/** Sum camera + screen counters into one video reading; `undefined` if neither exists. */
export function mergeVideoCounters(
  camera: EncoderActorCounters | undefined,
  screen: EncoderActorCounters | undefined
): EncoderActorCounters | undefined {
  if (camera === undefined && screen === undefined) return undefined;
  return {
    encodedFrames: (camera?.encodedFrames ?? 0) + (screen?.encodedFrames ?? 0),
    encodedBytes: (camera?.encodedBytes ?? 0) + (screen?.encodedBytes ?? 0),
    droppedFrames: (camera?.droppedFrames ?? 0) + (screen?.droppedFrames ?? 0),
    keyframes: (camera?.keyframes ?? 0) + (screen?.keyframes ?? 0),
    lastTimestampUs: mergeLastTimestampUs(camera?.lastTimestampUs, screen?.lastTimestampUs),
  };
}

function trackPublishStatsSetup({
  state,
  context,
  config = {},
}: {
  state: {
    publishStats: Signal<TrackPublishStatsState['publishStats']>;
  };
  context: {
    cameraEncoderActor: ReadonlySignal<TrackPublishStatsContext['cameraEncoderActor']>;
    screenEncoderActor: ReadonlySignal<TrackPublishStatsContext['screenEncoderActor']>;
    audioEncoderActor: ReadonlySignal<TrackPublishStatsContext['audioEncoderActor']>;
    catalogTrackPublisher: ReadonlySignal<TrackPublishStatsContext['catalogTrackPublisher']>;
    videoTrackPublisher: ReadonlySignal<TrackPublishStatsContext['videoTrackPublisher']>;
    screenTrackPublisher: ReadonlySignal<TrackPublishStatsContext['screenTrackPublisher']>;
    audioTrackPublisher: ReadonlySignal<TrackPublishStatsContext['audioTrackPublisher']>;
    publishSessionActor: ReadonlySignal<TrackPublishStatsContext['publishSessionActor']>;
  };
  config?: TrackPublishStatsConfig;
}): Reactor<TrackPublishStatsFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<TrackPublishStatsFsmState>({
    initial: 'no-encoders',
    monitor: () =>
      context.cameraEncoderActor.get() || context.screenEncoderActor.get() || context.audioEncoderActor.get()
        ? 'sampling'
        : 'no-encoders',
    states: {
      'no-encoders': {},

      sampling: {
        // effects (not entry) so an actor identity change (rebuilt
        // cluster) restarts the interval with fresh delta baselines.
        effects: () => {
          // Tracked: the sampled encoder actors are fixed per effect run.
          // The transport-side slots below are re-peeked lazily per sample
          // instead — publishers come and go with the session, and their
          // churn must not restart the interval.
          const camera = context.cameraEncoderActor.get();
          const screen = context.screenEncoderActor.get();
          const audio = context.audioEncoderActor.get();

          let lastAtMs = Date.now();
          let lastVideo = mergeVideoCounters(readCounters(camera), readCounters(screen));
          let lastAudio = readCounters(audio);

          const sample = () => {
            const nowMs = Date.now();
            const dtSec = (nowMs - lastAtMs) / 1000;
            const videoNow = mergeVideoCounters(readCounters(camera), readCounters(screen));
            const audioNow = readCounters(audio);
            const publishers = [
              peek(context.catalogTrackPublisher),
              peek(context.videoTrackPublisher),
              peek(context.screenTrackPublisher),
              peek(context.audioTrackPublisher),
            ].filter((publisher) => publisher !== undefined);
            const sum = (read: (counters: TrackPublisherCounters) => number): number =>
              publishers.reduce((total, publisher) => total + read(peek(publisher.snapshot).context), 0);
            const sessionActor = peek(context.publishSessionActor);
            state.publishStats.set({
              encodedFps: perSecond(videoNow, lastVideo, 'encodedFrames', dtSec),
              videoBitrate: perSecond(videoNow, lastVideo, 'encodedBytes', dtSec) * 8,
              audioBitrate: perSecond(audioNow, lastAudio, 'encodedBytes', dtSec) * 8,
              droppedFrames: (videoNow?.droppedFrames ?? 0) + (audioNow?.droppedFrames ?? 0),
              droppedGroups: sum((counters) => counters.droppedGroups),
              // Bytes the publishers handed to the transport — 0 while no
              // session is publishing (nothing has been sent).
              bytesSent: sum((counters) => counters.bytesSent),
              subscriberCount: sessionActor ? peek(sessionActor.snapshot).context.subscriberCount : Number.NaN,
            });
            lastAtMs = nowMs;
            lastVideo = videoNow;
            lastAudio = audioNow;
          };

          const intervalId: ReturnType<typeof setInterval> = setInterval(
            sample,
            config.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS
          );
          return () => {
            clearInterval(intervalId);
            state.publishStats.set(undefined);
          };
        },
      },
    },
  });
}

export const trackPublishStats = defineBehavior({
  stateKeys: ['publishStats'],
  contextKeys: [
    'cameraEncoderActor',
    'screenEncoderActor',
    'audioEncoderActor',
    'catalogTrackPublisher',
    'videoTrackPublisher',
    'screenTrackPublisher',
    'audioTrackPublisher',
    'publishSessionActor',
  ],
  setup: trackPublishStatsSetup,
});
