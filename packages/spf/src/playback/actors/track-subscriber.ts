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
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import { toLocFrame } from '../../media/moq/loc';
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
}

type SubscriberMessage =
  | { type: 'subscribed' }
  | { type: 'frame-buffered'; frame: JitterFrame; totalBytes: number; totalDurationMs: number }
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

export function createTrackSubscriberActor(options: CreateTrackSubscriberOptions): TrackSubscriberActor {
  const { session, track } = options;
  const timescale = track.moq.timescale;

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
    if (destroyed || object.status !== 'normal') return;
    if (isBehindWatermark(object.groupId, object.objectId)) return;
    const loc = toLocFrame(object, timescale !== undefined ? { timescale } : {});
    if (!loc) return;
    const frame: JitterFrame = { groupId: object.groupId, objectId: object.objectId, ...loc };
    insertFrame(frame);

    const now = performance.now();
    const durationMs = lastArrivalMs === undefined ? 0 : now - lastArrivalMs;
    lastArrivalMs = now;
    totalBytes += object.payload.byteLength;
    totalDurationMs += durationMs;
    inner.send({ type: 'frame-buffered', frame, totalBytes, totalDurationMs });
  };

  const notifyDrain = (): void => {
    inner.send({
      type: 'buffer-drained',
      frameCount: frames.length,
      oldestTimestampUs: frames[0]?.timestampUs,
    });
  };

  const subscribe = (parameters: MessageParameters): void => {
    subscription = session.subscribe(
      { trackNamespace: track.moq.namespace, trackName: track.moq.name, parameters },
      {
        onOk: () => inner.send({ type: 'subscribed' }),
        onObject: handleObject,
        onDone: (done) => inner.send({ type: 'done', done }),
        onError: (error) => {
          if (error.errorCode === REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN && options.refreshAuth && !authRetried) {
            authRetried = true;
            void options
              .refreshAuth()
              .then((refreshed) => {
                if (destroyed) return;
                subscribe({ ...parameters, ...refreshed, locationFilter: parameters.locationFilter });
              })
              .catch((refreshError) => inner.send({ type: 'error', error: refreshError }));
            return;
          }
          inner.send({ type: 'error', error });
        },
      }
    );
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
      subscription?.cancel();
      frames.length = 0;
      inner.destroy();
    },
  };
}
