/**
 * Machine actor publishing one MOQT track as subgroup data streams.
 *
 * Mechanism actor per the mechanism/policy split: it knows how to turn a serial stream of packaged frames into MOQT
 * groups — open a unidirectional stream per group (through the injected `openUniStream` seam, so it stays wire-agnostic
 * and DOM-free), write the subgroup header and delta-encoded objects, FIN at each group boundary — and it owns the
 * live-publishing drop policy: when more than `maxQueuedGroups` groups are still queued behind transport backpressure
 * at a group boundary, the stale groups are reset (stream abort) and publishing resumes with the boundary frame,
 * counting `droppedGroups`. _What_ to publish (encoder wiring, catalog derivation, track registration) lives in the
 * publish behaviors.
 *
 * **Data flows only while bound to a subscription.** Announce-and-serve ingest is pull-through: a subgroup stream is
 * only meaningful under a track alias the session bound with a SUBSCRIBE_OK, and an unbound alias is the peer's
 * "unknown track alias" (stream dropped after a 1 s grace). `{type:'bind'}` carries the current subscription's alias;
 * frames arriving unbound are dropped without opening streams. Groups never span bindings — a bind or unbind resets the
 * open group, so a fresh subscription starts at the next keyframe (`groupPerFrame` tracks start at the next frame). For
 * tracks whose frames flow only on _change_ rather than on a cadence — the catalog — waiting for the next frame would
 * stall a new subscription forever, so `replayLastGroupOnBind` retains the latest frame (bound or not) and re-emits it
 * as a fresh group on every bind.
 *
 * Group mapping follows MSF: video starts a new group on every keyframe (`objectId` resets to 0 — the extraction side
 * recovers the keyframe flag from `objectId === 0`); audio and catalog tracks set `groupPerFrame`, where every frame is
 * its own single-object group (all audio frames are independently decodable per LOC, and every catalog update must be a
 * random-access point).
 *
 * A `SerialRunner` serializes the stream work: object order inside a group and group order on the wire both follow
 * message order. Async completions feed the reactive snapshot counters through internal messages, mirroring
 * `actors/dom/encoder-actor.ts`.
 */
import type { MessageActor } from '../../core/actors/create-machine-actor';
import { createMachineActor } from '../../core/actors/create-machine-actor';
import { SerialRunner, Task } from '../../core/tasks/task';
import type { PropertyPair } from '../../media/moq/loc';
import type { SubgroupWriter } from '../../network/moqt/subgroup-writer';
import { createSubgroupWriter } from '../../network/moqt/subgroup-writer';

// =============================================================================
// Types
// =============================================================================

/** Opens one unidirectional stream on the publish session's transport. */
export type OpenUniStream = () => Promise<WritableStream<Uint8Array>>;

export type TrackPublisherUserState = 'publishing' | 'ended';
export type TrackPublisherState = TrackPublisherUserState | 'destroyed';

/** Cumulative publish counters exposed on the actor snapshot. */
export interface TrackPublisherCounters {
  /**
   * Groups whose data stream was actually opened (including later-reset ones). A group dropped while still queued
   * behind backpressure never opened a stream and is not counted. The boundary is the commit to writing the subgroup
   * header: an open that resolves into an already-aborted group is reset before any bytes, so the peer cannot attribute
   * that stream to this track and it is deliberately excluded too.
   */
  openedGroups: number;
  /** Groups written to completion (FIN). */
  publishedGroups: number;
  /** Objects fully written. */
  publishedObjects: number;
  /** Groups reset (or failed) without completing. */
  droppedGroups: number;
  /** Payload bytes fully written. */
  bytesSent: number;
  /** Groups accepted but not yet FINed (backpressure depth). */
  queuedGroups: number;
  /** Timestamp of the most recently written object; NaN before the first. */
  lastTimestampUs: number;
}

export type TrackPublisherMessage =
  | {
      type: 'frame';
      payload: Uint8Array;
      /** LOC object properties (`packageLocFrame` output rides through). */
      properties: readonly PropertyPair[];
      /** Starts a new group (ignored when `groupPerFrame` is set). */
      keyframe: boolean;
      timestampUs: number;
    }
  | {
      /** A subscription now carries the track; subgroups use this alias. */
      type: 'bind';
      trackAlias: number;
    }
  | {
      /** No live subscription — stop opening streams, drop frames. */
      type: 'unbind';
    }
  | { type: 'end' };

export type TrackPublisherActor = MessageActor<TrackPublisherState, TrackPublisherCounters, TrackPublisherMessage>;

export interface TrackPublisherOptions {
  openUniStream: OpenUniStream;
  /**
   * Every frame becomes its own single-object group. The LOC/MSF audio and catalog mapping — every object is a
   * random-access point.
   */
  groupPerFrame?: boolean;
  /**
   * Re-emit the most recent frame as a fresh group on every `bind` — for tracks whose frames flow on change rather than
   * on a cadence (the catalog), where a new subscription must not wait for the next change. Only meaningful with
   * `groupPerFrame`.
   */
  replayLastGroupOnBind?: boolean;
  /**
   * Groups allowed to queue behind transport backpressure before the drop policy resets them and resumes at the
   * boundary frame. Default 3.
   */
  maxQueuedGroups?: number;
  /** Publisher priority for every subgroup header; omitted → subscriber default. */
  priority?: number;
  /** Stream failures (open/write/fin) land here; the failed group counts as dropped. */
  onError?: (error: unknown) => void;
}

export const DEFAULT_MAX_QUEUED_GROUPS = 3;

// =============================================================================
// Implementation
// =============================================================================

/** One group's stream plumbing, shared between the queued tasks that serve it. */
interface GroupCell {
  groupId: number;
  /** The binding's alias at group start — groups never span bindings. */
  trackAlias: number;
  writer?: SubgroupWriter;
  aborted: boolean;
}

/** Snapshot-context updates driven by the async stream work. */
type InternalMessage =
  | { type: 'object-written'; bytes: number; timestampUs: number }
  | { type: 'group-opened' }
  | { type: 'group-finished' }
  | { type: 'groups-dropped'; count: number };

export function createTrackPublisherActor(options: TrackPublisherOptions): TrackPublisherActor {
  const { openUniStream, onError } = options;
  const groupPerFrame = options.groupPerFrame === true;
  const replayLastGroupOnBind = options.replayLastGroupOnBind === true;
  const maxQueuedGroups = options.maxQueuedGroups ?? DEFAULT_MAX_QUEUED_GROUPS;

  type Message = TrackPublisherMessage | InternalMessage;

  const runner = new SerialRunner();

  // Enqueue-side plumbing (which stream serves which group) — not actor
  // bookkeeping, so it stays out of the snapshot. The snapshot counters
  // mirror it through the internal messages.
  const openCells: GroupCell[] = [];
  let currentCell: GroupCell | undefined;
  /** The group `{type:'end'}` gracefully closed — destroy() FINs, not resets. */
  let endedCell: GroupCell | undefined;
  let nextGroupId = 0;
  let nextObjectId = 0;
  /** The live subscription's alias; unbound → frames drop, no streams open. */
  let boundAlias: number | undefined;
  /** Latest frame, retained for replay-on-bind (bound or not). */
  let lastFrame: Extract<TrackPublisherMessage, { type: 'frame' }> | undefined;

  // Assigned right after createMachineActor returns; the runner tasks only
  // complete asynchronously, well after construction.
  let inner: MessageActor<TrackPublisherState, TrackPublisherCounters, Message> | undefined;

  const removeCell = (cell: GroupCell): void => {
    const index = openCells.indexOf(cell);

    if (index >= 0) openCells.splice(index, 1);
  };

  /** A stream failure kills its group; later groups get fresh streams. */
  const failCell = (cell: GroupCell) => (error: unknown) => {
    if (cell.aborted) return;

    cell.aborted = true;
    cell.writer?.abort(error);

    if (currentCell === cell) currentCell = undefined;

    removeCell(cell);
    inner?.send({ type: 'groups-dropped', count: 1 });
    onError?.(error);
  };

  /**
   * FIN the cell's stream without holding the publish chain. By the time a group FINs, every one of its writes has been
   * accepted by the transport, so what `fin()` still waits for is the peer acknowledging the stream close — peer
   * latency, not send backpressure. The cell therefore leaves the backpressure queue immediately, and the FIN settles
   * detached, landing on the counters (or the drop path) when it does. Serializing that settlement into the runner is
   * what previously capped a group-per-frame track at ~1 group per close round trip and let the drop policy shred it
   * (~80% of audio groups against a real relay at ~50 ms close latency).
   */
  const finishCell = (cell: GroupCell): void => {
    removeCell(cell);
    const fin = cell.writer?.fin() ?? Promise.resolve();

    fin.then(() => inner?.send({ type: 'group-finished' }), failCell(cell));
  };

  /**
   * Await the pending open, but stop waiting the moment the task is aborted: `SerialRunner.abortAll()` only signals —
   * the chain still waits for the in-flight task to settle, so a hung open (exhausted uni-stream credit, a stalling
   * transport) would otherwise hold every later group hostage past a drop or rebind. Abandonment resolves to
   * `undefined` (the same silent early-return an abort always was, never the error path), and a stream that surfaces
   * after it belongs to a group that no longer exists — aborted on arrival.
   */
  const raceOpenAgainstAbort = (
    opening: Promise<WritableStream<Uint8Array>>,
    signal: AbortSignal
  ): Promise<WritableStream<Uint8Array> | undefined> =>
    new Promise((resolve, reject) => {
      const abandon = () => {
        opening.then(
          (late) => void late.abort().catch(() => {}),
          () => {}
        );
        resolve(undefined);
      };

      if (signal.aborted) {
        abandon();
        return;
      }

      signal.addEventListener('abort', abandon, { once: true });
      opening.then(
        (stream) => {
          signal.removeEventListener('abort', abandon);
          resolve(stream);
        },
        (error) => {
          signal.removeEventListener('abort', abandon);
          reject(error);
        }
      );
    });

  const scheduleOpen = (cell: GroupCell, frame: Extract<TrackPublisherMessage, { type: 'frame' }>): void => {
    const objectId = 0;

    runner
      .schedule(
        new Task(async (signal) => {
          if (signal.aborted || cell.aborted) return;

          const stream = await raceOpenAgainstAbort(openUniStream(), signal);
          if (stream === undefined) return;

          // `signal.aborted` again, not just the cell: destroy() leaves the
          // graceful cell un-aborted so an existing writer can FIN, but when
          // the open was still in flight there is no writer to FIN — the
          // aborted runner signal is the only teardown fact, and proceeding
          // would write into a destroyed actor and leak a never-FINned stream.
          if (signal.aborted || cell.aborted) {
            stream.abort().catch(() => {});
            return;
          }

          // Only now does a data stream exist for this track on the wire —
          // counting at queue time inflated the opened-stream count with
          // groups that were dropped before they ever opened one.
          inner?.send({ type: 'group-opened' });
          cell.writer = createSubgroupWriter(stream, {
            trackAlias: cell.trackAlias,
            groupId: cell.groupId,
            priority: options.priority,
            hasProperties: true,
            endOfGroup: true,
          });
          await cell.writer.writeObject({ objectId, properties: frame.properties, payload: frame.payload });
          inner?.send({ type: 'object-written', bytes: frame.payload.length, timestampUs: frame.timestampUs });

          if (groupPerFrame) finishCell(cell);
        })
      )
      .catch(failCell(cell));
  };

  const scheduleWrite = (
    cell: GroupCell,
    objectId: number,
    frame: Extract<TrackPublisherMessage, { type: 'frame' }>
  ): void => {
    runner
      .schedule(
        new Task(async (signal) => {
          if (signal.aborted || cell.aborted) return;

          await cell.writer!.writeObject({ objectId, properties: frame.properties, payload: frame.payload });
          inner?.send({ type: 'object-written', bytes: frame.payload.length, timestampUs: frame.timestampUs });
        })
      )
      .catch(failCell(cell));
  };

  const scheduleFin = (cell: GroupCell): void => {
    runner
      .schedule(
        new Task(async (signal) => {
          // Queued behind the group's writes so the FIN can only start
          // once they were accepted; the settlement itself is detached.
          if (signal.aborted || cell.aborted) return;

          finishCell(cell);
        })
      )
      .catch(failCell(cell));
  };

  /**
   * The drop policy: reset every queued group (streams abort → pending writes reject → the runner chain unblocks) and
   * resume fresh at the boundary frame that triggered the check. Also the unbind sweep, with its own reason.
   */
  const dropQueuedGroups = (reason = 'dropped a stale group under transport backpressure'): number => {
    const dropped = openCells.splice(0);

    for (const cell of dropped) {
      cell.aborted = true;
      cell.writer?.abort(new Error(`moq track publisher: ${reason}`));
    }

    runner.abortAll();
    currentCell = undefined;
    return dropped.length;
  };

  inner = createMachineActor<TrackPublisherUserState, TrackPublisherCounters, Message>({
    initial: 'publishing',
    context: {
      openedGroups: 0,
      publishedGroups: 0,
      publishedObjects: 0,
      droppedGroups: 0,
      bytesSent: 0,
      queuedGroups: 0,
      lastTimestampUs: Number.NaN,
    },
    states: {
      publishing: {
        on: {
          frame: (msg, { context, setContext }) => {
            if (replayLastGroupOnBind) lastFrame = msg;

            // Unbound: no subscription is reading this track — a stream
            // opened now would carry an alias the peer never registered.
            if (boundAlias === undefined) return;

            const startsGroup = groupPerFrame || msg.keyframe;

            if (!startsGroup) {
              // A delta frame can only extend an open group — before the
              // first keyframe (or after a failure killed the group) there
              // is nothing decodable to append to.
              if (!currentCell) return;

              scheduleWrite(currentCell, nextObjectId++, msg);
              return;
            }

            // Close the running group at the boundary (its FIN queues
            // behind any backpressured writes).
            if (currentCell && !groupPerFrame) {
              scheduleFin(currentCell);
              currentCell = undefined;
            }

            let droppedNow = 0;

            if (openCells.length > maxQueuedGroups) droppedNow = dropQueuedGroups();

            const cell: GroupCell = { groupId: nextGroupId++, trackAlias: boundAlias, aborted: false };

            openCells.push(cell);
            currentCell = groupPerFrame ? undefined : cell;
            nextObjectId = 1;
            scheduleOpen(cell, msg);

            setContext({
              ...context,
              queuedGroups: openCells.length,
              droppedGroups: context.droppedGroups + droppedNow,
            });
          },
          bind: (msg, { context, setContext }) => {
            if (boundAlias === msg.trackAlias) return;

            // Groups never span bindings — and the previous binding's
            // groups die with it, queued ones included: a queued open
            // firing later would put a stream on the wire under an alias
            // whose subscription already ended (the peer's unknown-alias
            // drop), and stale serial work would delay the new
            // subscription's first data behind it. Video resumes at its
            // next keyframe under the new alias.
            if (boundAlias !== undefined) {
              const droppedNow = dropQueuedGroups('the subscription was replaced with the group unfinished');

              if (droppedNow > 0) {
                setContext({
                  ...context,
                  queuedGroups: openCells.length,
                  droppedGroups: context.droppedGroups + droppedNow,
                });
              }
            }

            boundAlias = msg.trackAlias;

            // The new subscription must not wait for the next change-driven
            // frame; the re-sent frame takes the ordinary path (queued
            // behind this message, boundAlias already set).
            if (replayLastGroupOnBind && lastFrame) inner?.send(lastFrame);
          },
          unbind: (_, { context, setContext }) => {
            if (boundAlias === undefined) return;

            boundAlias = undefined;
            // Nothing reads the queued groups anymore and the peer resets
            // whatever is still in flight — drop locally through the
            // policy path (counted, no error): an unsubscribe is ordinary
            // pull-through lifecycle, not a failure.
            const droppedNow = dropQueuedGroups('the subscription ended with the group unfinished');

            setContext({
              ...context,
              queuedGroups: openCells.length,
              droppedGroups: context.droppedGroups + droppedNow,
            });
          },
          end: (_, { transition }) => {
            if (currentCell) {
              endedCell = currentCell;
              scheduleFin(currentCell);
              currentCell = undefined;
            }

            transition('ended');
          },
          'object-written': (msg, { context, setContext }) => {
            setContext({
              ...context,
              publishedObjects: context.publishedObjects + 1,
              bytesSent: context.bytesSent + msg.bytes,
              lastTimestampUs: msg.timestampUs,
            });
          },
          'group-opened': (_, { context, setContext }) => {
            setContext({ ...context, openedGroups: context.openedGroups + 1 });
          },
          'group-finished': (_, { context, setContext }) => {
            setContext({
              ...context,
              publishedGroups: context.publishedGroups + 1,
              queuedGroups: openCells.length,
            });
          },
          'groups-dropped': (msg, { context, setContext }) => {
            setContext({
              ...context,
              droppedGroups: context.droppedGroups + msg.count,
              queuedGroups: openCells.length,
            });
          },
        },
      },
      ended: {
        // Late frames are ignored; queued work still drains, so the
        // counter updates keep landing.
        on: {
          'object-written': (msg, { context, setContext }) => {
            setContext({
              ...context,
              publishedObjects: context.publishedObjects + 1,
              bytesSent: context.bytesSent + msg.bytes,
              lastTimestampUs: msg.timestampUs,
            });
          },
          'group-opened': (_, { context, setContext }) => {
            setContext({ ...context, openedGroups: context.openedGroups + 1 });
          },
          'group-finished': (_, { context, setContext }) => {
            setContext({
              ...context,
              publishedGroups: context.publishedGroups + 1,
              queuedGroups: openCells.length,
            });
          },
          'groups-dropped': (msg, { context, setContext }) => {
            setContext({
              ...context,
              droppedGroups: context.droppedGroups + msg.count,
              queuedGroups: openCells.length,
            });
          },
        },
      },
    },
  });

  const actor = inner;

  return {
    get snapshot() {
      return actor.snapshot;
    },
    send(message: TrackPublisherMessage): void {
      actor.send(message);
    },
    destroy(): void {
      // Every opened stream must end deterministically: the open group
      // (or the one `{type:'end'}` just closed gracefully) gets a
      // best-effort FIN directly at the stream level — the runner is torn
      // down below, so its queued fin task may never run — while groups
      // still queued behind transport backpressure are reset the way
      // `dropQueuedGroups` resets them, which also rejects their in-flight
      // backpressured writes instead of leaving them hanging.
      const graceful = currentCell ?? endedCell;

      currentCell = undefined;
      endedCell = undefined;

      for (const cell of openCells.splice(0)) {
        if (cell.aborted) continue;

        if (cell === graceful) {
          void cell.writer?.fin().catch(() => {});
        } else {
          cell.aborted = true;
          cell.writer?.abort(new Error('moq track publisher: destroyed with the group unfinished'));
        }
      }

      runner.destroy();
      actor.destroy();
    },
  };
}
