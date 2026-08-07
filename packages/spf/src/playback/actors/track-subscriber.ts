/**
 * Per-track subscription actor: subscribes to one MoQ track, converts
 * arriving LOC objects into decodable frames, and maintains the jitter
 * buffer the renderers drain.
 *
 * The reactive snapshot carries buffer *stats* (depth, latest group,
 * byte-arrival samples) — not the frames themselves. Frames live in an
 * internal queue ordered by (group, object) and are pulled by renderer
 * actors via `peek`/`dequeue`; pushing every frame through a signal would
 * make each frame arrival a reactive broadcast for no reader's benefit.
 *
 * Multiple instances per media type may coexist during a make-before-break
 * switch handoff (`subscribe-selected-tracks` owns that choreography); the
 * `hasDecodableFrame` context flag is the handoff's readiness signal —
 * true once a keyframe-led group is buffered.
 *
 * Auth-expiry retry (MSF §11.4): a REQUEST_ERROR with EXPIRED_AUTH_TOKEN
 * asks `refreshAuth` for fresh parameters and resubscribes once.
 *
 * Data-starvation watchdog (`stallTimeoutMs`): a live MSF media track
 * delivers continuously, so a subscription that stays silent past the
 * deadline is treated as dead even though the wire never said so —
 * the subscription is cancelled and the status goes `'error'`, which is
 * the terminal signal `subscribe-selected-tracks` recovers from.
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import { parseTrackTimescale, toLocFrame } from '../../media/moq/loc';
import type { MoqTrack } from '../../media/moq/parse-catalog';
import type { LocationFilter, MessageParameters } from '../../network/moqt/control-messages';
import { REQUEST_ERROR_CODE } from '../../network/moqt/control-messages';
import type { MoqtObject } from '../../network/moqt/object-stream';
import type { MoqtSession, PublishDone, RequestError, Subscription } from '../../network/moqt/session';

// =============================================================================
// Types
// =============================================================================

export type TrackSubscriberStatus = 'pending' | 'active' | 'ended' | 'error';

/** A decodable frame in the jitter buffer, in (group, object) order. */
export interface JitterFrame {
  groupId: number;
  objectId: number;
  timestampUs: number;
  isKey: boolean;
  videoConfig?: Uint8Array;
  payload: Uint8Array;
}

export interface TrackSubscriberContext {
  status: TrackSubscriberStatus;
  /** True once a keyframe-led group is buffered — safe to hand off to a decoder. */
  hasDecodableFrame: boolean;
  /** Jitter-buffer stats for latency control. */
  frameCount: number;
  newestTimestampUs?: number;
  oldestTimestampUs?: number;
  latestGroupId?: number;
  /**
   * Cumulative object-arrival throughput: total payload bytes received and
   * total inter-arrival time. Cumulative (rather than per-object) so a
   * microtask-batched observer that sees only the latest snapshot still
   * accounts for every object — it diffs against its last-consumed totals.
   * `seq` increments per arrival as a cheap change marker.
   */
  arrivals?: { seq: number; totalBytes: number; totalDurationMs: number };
  /**
   * **Decaying arrival-offset envelope** — the path-jitter primitive the
   * adaptive latency controller reads.
   *
   * Each admitted frame samples `arrivalWallMs − mediaTimeMs`. That number
   * has no absolute meaning (the two clocks have unrelated epochs), so the
   * envelope publishes the *spread*: `maxOffsetMs − minOffsetMs` is how
   * much later the worst recently-observed frame arrived than the best
   * one, i.e. exactly the jitter a buffer has to absorb.
   *
   * The bounds decay toward the current sample with a fixed time constant
   * rather than being an unbounded running min/max. An unbounded minimum
   * is what makes an offset-based latency estimate drift permanently
   * pessimistic after one lucky early frame — the bound has to forget.
   *
   * `epoch` counts the times the envelope has been *restarted*
   * (`resetArrivalBaseline`, on the auth-expiry resubscribe), so a reader
   * sampling this at its own cadence can tell "the same measurement,
   * continued" from "a different measurement that happens to be on the same
   * actor" without inferring it from the other two numbers. See
   * `adaptLatencyTarget`, whose observation window that distinction gates.
   */
  arrivalJitter?: { minOffsetMs: number; maxOffsetMs: number; sampleCount: number; epoch: number };
  error?: RequestError | unknown;
  done?: PublishDone;
}

export interface CreateTrackSubscriberOptions {
  session: MoqtSession;
  track: MoqTrack;
  /** Where to join the track. Default: `{ type: 'largest-object' }` (live edge). */
  locationFilter?: LocationFilter;
  /** Extra request parameters (auth tokens, priority). */
  parameters?: MessageParameters;
  /** Auth-expiry seam: return refreshed parameters to retry the subscribe with. */
  refreshAuth?(): Promise<MessageParameters>;
  /**
   * Data-starvation watchdog: a live MSF media track delivers continuously,
   * so a subscription this long without a single object is dead in a way
   * the wire never said — a relay that dropped its publisher without
   * sending PUBLISH_DONE, or a half-closed path. On expiry the actor
   * cancels the subscription and reports `status: 'error'`, which is the
   * signal `subscribe-selected-tracks` recovers from by re-subscribing at
   * the live edge. `0` disables. Default 10 000 ms.
   */
  stallTimeoutMs?: number;
}

type SubscriberMessage =
  | { type: 'subscribed' }
  | {
      type: 'frame-buffered';
      frame: JitterFrame;
      totalBytes: number;
      totalDurationMs: number;
      arrivalJitter: TrackSubscriberContext['arrivalJitter'];
    }
  | { type: 'buffer-drained'; frameCount: number; oldestTimestampUs?: number; newestTimestampUs?: number }
  | { type: 'done'; done: PublishDone }
  | { type: 'error'; error: RequestError | unknown };

export interface TrackSubscriberActor
  extends Pick<TransitionActor<TrackSubscriberContext, SubscriberMessage>, 'snapshot'> {
  readonly track: MoqTrack;
  peek(): JitterFrame | undefined;
  dequeue(): JitterFrame | undefined;
  /**
   * Catch-up: drop everything before the newest buffered keyframe-led
   * group. Returns the number of dropped frames.
   */
  skipToLatestGroup(): number;
  destroy(): void;
}

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_LOCATION_FILTER: LocationFilter = { type: 'largest-object' };

/** See `CreateTrackSubscriberOptions.stallTimeoutMs`. */
export const DEFAULT_STALL_TIMEOUT_MS = 10_000;

/**
 * Time constant of the arrival-offset envelope's decay, in milliseconds.
 * The bounds relax toward the current sample by `1 − e^(−Δt/τ)` per
 * arrival, so the envelope describes roughly the last 4 seconds: long
 * enough to see several GOP boundaries at any sane cadence, short enough
 * that a single congestion spike stops widening the estimate a few seconds
 * after the path recovers.
 */
const ARRIVAL_ENVELOPE_TAU_MS = 4_000;

export function createTrackSubscriberActor(options: CreateTrackSubscriberOptions): TrackSubscriberActor {
  const { session, track } = options;
  const catalogTimescale = track.moq.timescale;

  /**
   * TIMESCALE from the SUBSCRIBE_OK's Track Properties, when the peer sent one.
   *
   * It outranks the catalog's `timescale` rather than filling in for it, and the
   * reason is which of the two describes *these bytes*: a relay converts every
   * timestamp into the timescale it declares for the track it is serving, so the
   * transport's declaration is the unit the objects on this subscription are
   * actually in. The catalog states what the origin published, which is the same
   * number until something in the path rescales it.
   */
  let trackTimescale: number | undefined;

  // The jitter buffer proper. Objects can arrive out of order (each MSF
  // object rides its own stream), so insertion keeps (group, object)
  // order.
  const frames: JitterFrame[] = [];
  let destroyed = false;
  let sampleSeq = 0;
  let totalBytes = 0;
  let totalDurationMs = 0;
  let lastArrivalMs: number | undefined;
  let authRetried = false;
  let subscription: Subscription | undefined;

  // Data-starvation watchdog (see `stallTimeoutMs`): armed per subscribe
  // attempt, re-armed per arriving object, disarmed once the subscription
  // is dead by other means (done / error / destroy).
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const disarmStallTimer = (): void => {
    if (stallTimer === undefined) return;
    clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const armStallTimer = (): void => {
    if (stallTimeoutMs <= 0 || destroyed) return;
    // A straggler object still in flight after done/error must not re-arm
    // the watchdog on a subscription already reported dead — the re-armed
    // timer would fire a second 'error' at a consumer that moved on.
    const status = inner.snapshot.get().context.status;
    if (status === 'ended' || status === 'error') return;
    disarmStallTimer();
    stallTimer = setTimeout(() => {
      stallTimer = undefined;
      subscription?.cancel();
      inner.send({
        type: 'error',
        error: new Error(
          `MoQ track "${track.moq.name}" delivered no objects for ${stallTimeoutMs}ms; subscription presumed dead`
        ),
      });
    }, stallTimeoutMs);
  };

  // Decaying arrival-offset envelope (see `arrivalJitter` on the context).
  // Two numbers and no allocation, deliberately: this runs on every
  // admitted frame whether or not anything is reading it.
  let offsetMinMs: number | undefined;
  let offsetMaxMs = 0;
  let offsetSamples = 0;
  // Times the envelope has been restarted, published so a reader sampling at
  // its own cadence can recognise a new measurement — see `arrivalJitter`
  // and `resetArrivalBaseline`.
  let offsetEpoch = 0;

  const sampleArrivalOffset = (nowMs: number, timestampUs: number, elapsedMs: number | undefined): void => {
    const offsetMs = nowMs - timestampUs / 1000;
    if (offsetMinMs === undefined) {
      offsetMinMs = offsetMs;
      offsetMaxMs = offsetMs;
      offsetSamples = 1;
      return;
    }
    // Relax both bounds toward the sample, then let the sample itself
    // push whichever bound it is outside of. Relaxing first keeps a bound
    // from being pinned by a value it has already been pulled past.
    const relax = 1 - Math.exp(-(elapsedMs ?? 0) / ARRIVAL_ENVELOPE_TAU_MS);
    offsetMinMs += (offsetMs - offsetMinMs) * relax;
    offsetMaxMs += (offsetMs - offsetMaxMs) * relax;
    if (offsetMs < offsetMinMs) offsetMinMs = offsetMs;
    if (offsetMs > offsetMaxMs) offsetMaxMs = offsetMs;
    offsetSamples++;
  };

  // Drain watermark: the consumer has already taken everything at or
  // behind this (group, object) position. Late arrivals behind it must be
  // discarded — inserting them at frames[0] would reintroduce an
  // already-consumed prefix (stale deltas fed to a decoder that moved on;
  // old audio butt-joined after newer audio). The watermark lives for the
  // actor's whole lifetime: an actor is bound to one track (the
  // auth-expiry retry resubscribes the same track), so (group, object)
  // positions never restart. A different track means a new actor.
  let lastDrained: { groupId: number; objectId: number } | undefined;

  const isBehindWatermark = (groupId: number, objectId: number): boolean =>
    lastDrained !== undefined &&
    (groupId < lastDrained.groupId || (groupId === lastDrained.groupId && objectId <= lastDrained.objectId));

  const inner = createTransitionActor<TrackSubscriberContext, SubscriberMessage>(
    { status: 'pending', hasDecodableFrame: false, frameCount: 0 },
    (context, message) => {
      switch (message.type) {
        case 'subscribed':
          return context.status === 'pending' ? { ...context, status: 'active' } : context;
        case 'frame-buffered': {
          const { frame } = message;
          return {
            ...context,
            status: context.status === 'pending' ? 'active' : context.status,
            hasDecodableFrame: context.hasDecodableFrame || frame.isKey,
            frameCount: frames.length,
            newestTimestampUs: Math.max(context.newestTimestampUs ?? frame.timestampUs, frame.timestampUs),
            oldestTimestampUs: frames[0]?.timestampUs,
            latestGroupId: Math.max(context.latestGroupId ?? frame.groupId, frame.groupId),
            arrivals: { seq: ++sampleSeq, totalBytes: message.totalBytes, totalDurationMs: message.totalDurationMs },
            arrivalJitter: message.arrivalJitter,
          };
        }
        case 'buffer-drained':
          return {
            ...context,
            frameCount: message.frameCount,
            oldestTimestampUs: message.oldestTimestampUs,
            newestTimestampUs: message.newestTimestampUs ?? context.newestTimestampUs,
          };
        case 'done':
          return { ...context, status: 'ended', done: message.done };
        case 'error':
          return { ...context, status: 'error', error: message.error };
      }
    }
  );

  const insertFrame = (frame: JitterFrame): void => {
    let index = frames.length;
    while (index > 0) {
      const previous = frames[index - 1]!;
      if (
        previous.groupId < frame.groupId ||
        (previous.groupId === frame.groupId && previous.objectId < frame.objectId)
      ) {
        break;
      }
      index--;
    }
    frames.splice(index, 0, frame);
  };

  const handleObject = (object: MoqtObject): void => {
    if (destroyed) return;
    // Any object is proof of delivery — including status-only ones the
    // buffer ignores below — so the watchdog re-arms before any filtering.
    armStallTimer();
    if (object.status !== 'normal') return;
    if (isBehindWatermark(object.groupId, object.objectId)) return;
    const timescale = trackTimescale ?? catalogTimescale;
    const loc = toLocFrame(object, timescale !== undefined ? { timescale } : {});
    if (!loc) return;
    const frame: JitterFrame = { groupId: object.groupId, objectId: object.objectId, ...loc };
    insertFrame(frame);

    const now = performance.now();
    const elapsedMs = lastArrivalMs === undefined ? undefined : now - lastArrivalMs;
    // The first arrival only establishes the measurement baseline: its
    // bytes have no arrival interval, so counting them would overstate
    // the first throughput estimate.
    if (elapsedMs !== undefined) {
      totalBytes += object.payload.byteLength;
      totalDurationMs += elapsedMs;
    }
    lastArrivalMs = now;
    sampleArrivalOffset(now, frame.timestampUs, elapsedMs);
    inner.send({
      type: 'frame-buffered',
      frame,
      totalBytes,
      totalDurationMs,
      arrivalJitter: {
        minOffsetMs: offsetMinMs!,
        maxOffsetMs: offsetMaxMs,
        sampleCount: offsetSamples,
        epoch: offsetEpoch,
      },
    });
  };

  const notifyDrain = (): void => {
    inner.send({
      type: 'buffer-drained',
      frameCount: frames.length,
      oldestTimestampUs: frames[0]?.timestampUs,
    });
  };

  /**
   * Drop the arrival measurements' baseline, so the next admitted frame
   * establishes a new one instead of being timed against the last frame
   * before an outage.
   *
   * `elapsedMs` is the interval since the previous arrival, and both
   * measurements read it as *delivery* time. Across an auth-expiry
   * resubscribe it is nothing of the kind — it is the round trip through
   * `refreshAuth` plus a fresh SUBSCRIBE — and each measurement is wrong in
   * the direction that hides the problem:
   *
   * - The envelope relaxes its bounds by `1 − e^(−Δt/τ)`. Against a gap of
   *   several τ that factor is ~1, so both bounds collapse onto the single
   *   reconnected sample and the published spread drops to ~0 — the
   *   adaptive controller reads a perfectly jitter-free path in the moment
   *   just after the path failed, and proposes its lowest target there.
   * - The throughput totals fold the whole outage into `totalDurationMs`
   *   against one object's bytes, so the bandwidth estimator's next sample
   *   is one arbitrarily low outlier.
   *
   * Clearing the envelope rather than only its baseline also re-arms the
   * warm-up gate, which is what makes the reconnected subscription describe
   * itself: `adaptLatencyTarget` holds its last proposal while
   * `sampleCount` is short, exactly as it does for a subscriber handoff.
   *
   * `epoch` is how that controller *recognises* the restart, and it has to
   * be said outright rather than inferred from the restarted `sampleCount`.
   * The controller samples this context on a timer, not on every frame, so
   * a count that dips to zero and climbs back past its last-read value
   * inside one of those windows never appears to have gone backwards at all
   * — and at the cadences in play that is the ordinary case, not the corner:
   * the window is 2s, the gate wants 60 samples, and 60 samples is ~1.3s of
   * 48kHz audio. A counter that only ever rises is monotone in the reader's
   * sampled view; an epoch is not.
   */
  const resetArrivalBaseline = (): void => {
    lastArrivalMs = undefined;
    offsetMinMs = undefined;
    offsetMaxMs = 0;
    offsetSamples = 0;
    offsetEpoch++;
  };

  const subscribe = (parameters: MessageParameters): void => {
    subscription = session.subscribe(
      { trackNamespace: track.moq.namespace, trackName: track.moq.name, parameters },
      {
        onOk: (ok) => {
          trackTimescale = parseTrackTimescale(ok.trackProperties);
          inner.send({ type: 'subscribed' });
        },
        onObject: handleObject,
        onDone: (done) => {
          disarmStallTimer();
          inner.send({ type: 'done', done });
        },
        onError: (error) => {
          disarmStallTimer();
          if (error.errorCode === REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN && options.refreshAuth && !authRetried) {
            authRetried = true;
            void options
              .refreshAuth()
              .then((refreshed) => {
                if (destroyed) return;
                resetArrivalBaseline();
                subscribe({ ...parameters, ...refreshed, locationFilter: parameters.locationFilter });
              })
              .catch((refreshError) => inner.send({ type: 'error', error: refreshError }));
            return;
          }
          inner.send({ type: 'error', error });
        },
      }
    );
    // Armed after the subscribe is issued so the deadline also covers a
    // subscription that OKs and then never delivers — the case PUBLISH_DONE
    // and REQUEST_ERROR both fail to report.
    armStallTimer();
  };

  subscribe({
    ...options.parameters,
    locationFilter: options.locationFilter ?? DEFAULT_LOCATION_FILTER,
  });

  return {
    track,

    get snapshot() {
      return inner.snapshot;
    },

    peek(): JitterFrame | undefined {
      return frames[0];
    },

    dequeue(): JitterFrame | undefined {
      const frame = frames.shift();
      if (frame) {
        lastDrained = { groupId: frame.groupId, objectId: frame.objectId };
        notifyDrain();
      }
      return frame;
    },

    skipToLatestGroup(): number {
      // Find the newest group that starts with a keyframe in the buffer;
      // everything older is stale once we jump.
      let keyIndex = -1;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i]!.isKey) {
          keyIndex = i;
          break;
        }
      }
      if (keyIndex <= 0) return 0;
      frames.splice(0, keyIndex);
      // The jump makes everything before the kept keyframe stale —
      // including stragglers that have not arrived yet — so the watermark
      // sits just before it, not at the last spliced-out frame.
      const kept = frames[0]!;
      lastDrained = { groupId: kept.groupId, objectId: kept.objectId - 1 };
      notifyDrain();
      return keyIndex;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      disarmStallTimer();
      subscription?.cancel();
      frames.length = 0;
      inner.destroy();
    },
  };
}
