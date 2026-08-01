/**
 * Machine actor publishing one MOQT track as subgroup data streams.
 *
 * Mechanism actor per the mechanism/policy split: it knows how to turn a
 * serial stream of packaged frames into MOQT groups — open a
 * unidirectional stream per group (through the injected `openUniStream`
 * seam, so it stays wire-agnostic and DOM-free), write the subgroup
 * header and delta-encoded objects, FIN at each group boundary — and it
 * owns the live-publishing drop policy: when more than `maxQueuedGroups`
 * groups are still queued behind transport backpressure at a group
 * boundary, the stale groups are reset (stream abort) and publishing
 * resumes with the boundary frame, counting `droppedGroups`. *What* to
 * publish (encoder wiring, catalog derivation, track registration) lives
 * in the publish behaviors.
 *
 * Group mapping follows MSF: video starts a new group on every keyframe
 * (`objectId` resets to 0 — the extraction side recovers the keyframe
 * flag from `objectId === 0`); audio and catalog tracks set
 * `groupPerFrame`, where every frame is its own single-object group (all
 * audio frames are independently decodable per LOC, and every catalog
 * update must be a random-access point).
 *
 * A `SerialRunner` serializes the stream work: object order inside a
 * group and group order on the wire both follow message order. Async
 * completions feed the reactive snapshot counters through internal
 * messages, mirroring `actors/dom/encoder-actor.ts`.
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
   * Groups started. Each group opens one data stream, so this is the
   * opened-stream count (including later-reset ones) that draft-19's
   * PUBLISH_DONE Stream Count field reports (§10.11).
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
  | { type: 'end' };

export type TrackPublisherActor = MessageActor<TrackPublisherState, TrackPublisherCounters, TrackPublisherMessage>;

export interface TrackPublisherOptions {
  openUniStream: OpenUniStream;
  trackAlias: number;
  /**
   * Every frame becomes its own single-object group. The LOC/MSF audio and
   * catalog mapping — every object is a random-access point.
   */
  groupPerFrame?: boolean;
  /**
   * Groups allowed to queue behind transport backpressure before the drop
   * policy resets them and resumes at the boundary frame. Default 3.
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
  writer?: SubgroupWriter;
  aborted: boolean;
}

/** Snapshot-context updates driven by the async stream work. */
type InternalMessage =
  | { type: 'object-written'; bytes: number; timestampUs: number }
  | { type: 'group-finished' }
  | { type: 'groups-dropped'; count: number };

export function createTrackPublisherActor(options: TrackPublisherOptions): TrackPublisherActor {
  const { openUniStream, trackAlias, onError } = options;
  const groupPerFrame = options.groupPerFrame === true;
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
   * FIN the cell's stream without holding the publish chain. By the time
   * a group FINs, every one of its writes has been accepted by the
   * transport, so what `fin()` still waits for is the peer acknowledging
   * the stream close — peer latency, not send backpressure. The cell
   * therefore leaves the backpressure queue immediately, and the FIN
   * settles detached, landing on the counters (or the drop path) when it
   * does. Serializing that settlement into the runner is what previously
   * capped a group-per-frame track at ~1 group per close round trip and
   * let the drop policy shred it (~80% of audio groups against a real
   * relay at ~50 ms close latency).
   */
  const finishCell = (cell: GroupCell): void => {
    removeCell(cell);
    const fin = cell.writer?.fin() ?? Promise.resolve();
    fin.then(() => inner?.send({ type: 'group-finished' }), failCell(cell));
  };

  const scheduleOpen = (cell: GroupCell, frame: Extract<TrackPublisherMessage, { type: 'frame' }>): void => {
    const objectId = 0;
    runner
      .schedule(
        new Task(async (signal) => {
          if (signal.aborted || cell.aborted) return;
          const stream = await openUniStream();
          if (cell.aborted) {
            stream.abort().catch(() => {});
            return;
          }
          cell.writer = createSubgroupWriter(stream, {
            trackAlias,
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
   * The drop policy: reset every queued group (streams abort → pending
   * writes reject → the runner chain unblocks) and resume fresh at the
   * boundary frame that triggered the check.
   */
  const dropQueuedGroups = (): number => {
    const dropped = openCells.splice(0);
    for (const cell of dropped) {
      cell.aborted = true;
      cell.writer?.abort(new Error('moq track publisher: dropped a stale group under transport backpressure'));
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

            const cell: GroupCell = { groupId: nextGroupId++, aborted: false };
            openCells.push(cell);
            currentCell = groupPerFrame ? undefined : cell;
            nextObjectId = 1;
            scheduleOpen(cell, msg);

            setContext({
              ...context,
              openedGroups: nextGroupId,
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
