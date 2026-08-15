/**
 * Shared core for the WebCodecs encoder actors (`video-encoder.ts` /
 * `audio-encoder.ts`): a machine actor owning one `VideoEncoder` /
 * `AudioEncoder`, serializing `flush` work through a `SerialRunner`, and
 * turning encoder output into LOC-packaged frames pushed to a sink.
 *
 * Mechanism actor per the mechanism/policy split: it knows how to drive
 * the codec (configure / encode / flush / close, input backpressure,
 * always-close frame ownership) and counts what came out. *What* to
 * encode — frame pumping, keyframe cadence, encoder selection — lives in
 * the publish behaviors.
 *
 * Input backpressure: when the codec's `encodeQueueSize` exceeds the
 * configured depth, delta frames are dropped (and counted) rather than
 * queued; forced keyframes are never dropped so every MOQT group still
 * starts decodable. Every incoming frame is closed on every path —
 * encoded, dropped, mis-state, or error — the actor takes ownership at
 * `send()`.
 *
 * Timestamp rebasing: capture pipelines stamp frames on per-source
 * clocks (Chrome's camera, microphone, and canvas/WebAudio captures all
 * ride different bases), but MSF receivers sync tracks against ONE media
 * timeline — the playback engine's audio renderer owns the master clock
 * and its video renderer presents strictly by timestamp against it, so
 * an unrebased cross-track skew either holds every video frame "in the
 * future" forever or destroys A/V sync. Each actor therefore anchors its
 * first encoded frame to the shared wallclock (Unix-epoch microseconds,
 * LOC's absent-timescale timebase) and shifts every output by that
 * constant — intra-track pacing is capture-exact, and cross-track error
 * is bounded by the tracks' first-frame delivery jitter. One actor is one
 * *epoch* of its track's published timeline: `setupEncoderActors` passes
 * each kind's actors a shared `TrackTimeline` so a rebuilt actor
 * continues the previous epoch's clock domain instead of opening a fresh
 * wallclock anchor (see the `TrackTimeline` doc below).
 *
 * The reactive snapshot context is the counters `trackPublishStats`
 * samples. Its shape is mirrored structurally by that DOM-free behavior
 * (`publish/behaviors/track-publish-stats.ts`) — keep the two identical.
 */
import type { HandlerContext, MessageActor } from '../../../core/actors/create-machine-actor';
import { createMachineActor } from '../../../core/actors/create-machine-actor';
import { SerialRunner, Task } from '../../../core/tasks/task';
import type { EncodedChunkLike, PackagedLocFrame } from '../../../media/moq/loc-packaging';
import { packageLocFrame } from '../../../media/moq/loc-packaging';

// =============================================================================
// Types
// =============================================================================

/** Operational states of an encoder actor (`'destroyed'` is implicit). */
export type EncoderActorUserState = 'unconfigured' | 'encoding' | 'closed';
export type EncoderActorState = EncoderActorUserState | 'destroyed';

/**
 * Cumulative encode counters exposed on the actor snapshot.
 *
 * Structurally mirrored by `track-publish-stats.ts` (DOM-free, so it
 * cannot import this module) — the two declarations must stay identical.
 */
export interface EncoderActorCounters {
  /** Chunks the codec emitted (audio codecs re-frame, so ≠ inputs). */
  encodedFrames: number;
  /** Total encoded payload bytes emitted. */
  encodedBytes: number;
  /** Input frames dropped by backpressure. */
  droppedFrames: number;
  /** Emitted chunks that were keyframes. */
  keyframes: number;
  /** Timestamp of the most recently emitted chunk; NaN before the first. */
  lastTimestampUs: number;
}

/** Messages accepted by an encoder actor. */
export type EncoderMessage<Config, Frame> =
  | { type: 'configure'; config: Config }
  | { type: 'encode'; frame: Frame; keyFrame?: boolean }
  | { type: 'flush' }
  | { type: 'close' };

/** An encoder actor: message channel + reactive counter snapshot. */
export type EncoderActor<Config, Frame> = MessageActor<
  EncoderActorState,
  EncoderActorCounters,
  EncoderMessage<Config, Frame>
>;

/** Per-chunk metadata delivered to the sink beside the packaged frame. */
export interface EncodedChunkSinkMeta {
  keyframe: boolean;
  timestampUs: number;
  byteLength: number;
  /** Which capture pipeline this chunk came from — the sink-routing label. */
  track: 'camera' | 'screen' | 'audio';
}

/**
 * Receives every LOC-packaged encoded chunk. The moq publish engine's
 * default sink routes each chunk to the matching MOQT track publisher;
 * override it to observe or replace transport (the encode counters live
 * on the actor snapshot either way).
 */
export type EncodedChunkSink = (packaged: PackagedLocFrame, meta: EncodedChunkSinkMeta) => void;

/** Structural slice of `EncodedVideoChunkMetadata` / `EncodedAudioChunkMetadata`. */
export interface EncoderOutputMetadata {
  decoderConfig?: { description?: AllowSharedBufferSource };
}

/** Codec-facing adapter a specialization builds around the real encoder. */
export interface EncoderInstance<Config, Frame> {
  configure(config: Config): void;
  encode(frame: Frame, keyFrame: boolean): void;
  flush(): Promise<void>;
  /** Must be idempotent (guard on the codec's `state`). */
  close(): void;
  readonly encodeQueueSize: number;
}

export interface EncoderActorOptions {
  /**
   * Codec queue depth above which delta frames are dropped. Default 60 —
   * two seconds' worth at 30 fps.
   */
  maxQueueDepth?: number;
  /** Encoder failures (sync throws and codec error callbacks) land here. */
  onError?: (error: unknown) => void;
  /**
   * Shared wallclock the first frame's timestamp is rebased onto, in
   * microseconds since the Unix epoch (see the module doc). Injectable
   * for deterministic tests; defaults to `Date.now() * 1000`. Feeds the
   * default `timeline`; ignored when a `timeline` is given.
   */
  nowUs?: () => number;
  /**
   * The track's published timeline this actor stamps an epoch of.
   * `setupEncoderActors` passes one per kind so the clock domain survives
   * actor rebuilds; defaults to a private single-epoch timeline (a fresh
   * wallclock anchor).
   */
  timeline?: TrackTimeline;
  /**
   * Sink-routing label for this actor's chunks — independent of the codec
   * kind, since camera and screen are both `'video'` on the wire but must
   * route to different MOQT track publishers. Defaults to the video
   * specialization's `'camera'` / the audio specialization's `'audio'`.
   */
  sinkTrack?: EncodedChunkSinkMeta['track'];
}

export const DEFAULT_MAX_QUEUE_DEPTH = 60;

// =============================================================================
// Track timeline
// =============================================================================

/** Clock seams a track timeline reads; injectable for deterministic tests. */
export interface TrackTimelineClocks {
  /** Wallclock in microseconds since the Unix epoch; defaults to `Date.now() * 1000`. */
  nowUs?: () => number;
  /** Monotonic clock in microseconds; defaults to `performance.now() * 1000`. */
  monotonicNowUs?: () => number;
}

/**
 * One track's published clock domain, outliving the encoder actors that
 * stamp into it.
 *
 * An actor pins one rebase offset for its whole life (one *epoch* of the
 * track's timeline), so an actor rebuild — a capture-source switch, an
 * encoding change — would otherwise open a fresh wallclock anchor,
 * silently discarding the skew the old anchor had accumulated
 * (first-frame delivery staleness, capture-vs-wallclock drift, NTP
 * steps). The discarded skew lands on the wire as a raw timestamp step on
 * one track of an otherwise healthy broadcast — *backward* whenever it
 * exceeds the real acquisition gap — and once two tracks' timelines
 * diverge, exact A/V correspondence is unrecoverable downstream.
 *
 * Sharing one timeline across a kind's successive actors keeps the
 * domain: a new epoch anchors at the previous epoch's last recorded
 * timestamp plus the *monotonic* time since it — the real acquisition
 * gap, preserved as a gap (butt-joining it would desync the switched
 * track against the surviving ones by the gap length) and immune to
 * wallclock steps landing between epochs. The trade-off: the carried
 * skew keeps absolute wallclock error in the published timestamps, which
 * only `now − timestamp` glass-to-glass estimates see — playback latency
 * control is buffer-depth-based and unaffected.
 */
export interface TrackTimeline {
  /**
   * The rebase offset for a new epoch whose first input frame carries
   * `captureTimestampUs`: the first epoch anchors that frame to the
   * shared wallclock; every later epoch continues the previous one (see
   * the interface doc).
   */
  anchorOffsetUs(captureTimestampUs: number): number;
  /** Record an input frame's published-domain timestamp for the epoch. */
  recordFrame(publishedTimestampUs: number): void;
}

export function createTrackTimeline(clocks: TrackTimelineClocks = {}): TrackTimeline {
  const nowUs = clocks.nowUs ?? (() => Date.now() * 1000);
  const monotonicNowUs = clocks.monotonicNowUs ?? (() => performance.now() * 1000);
  let lastFrameUs: number | undefined;
  let lastFrameMonotonicUs: number | undefined;
  return {
    // Both branches round: monotonic clocks are fractional-microsecond
    // (and injected clocks may be), a fractional offset would make every
    // published timestamp fractional, and the MOQT varint writer rejects
    // non-integers at the LOC default timescale (`microsecondsToLocTimestamp`
    // passes microseconds through unrounded).
    anchorOffsetUs(captureTimestampUs) {
      if (lastFrameUs === undefined || lastFrameMonotonicUs === undefined) {
        return Math.round(nowUs() - captureTimestampUs);
      }
      return Math.round(lastFrameUs + (monotonicNowUs() - lastFrameMonotonicUs) - captureTimestampUs);
    },
    recordFrame(publishedTimestampUs) {
      lastFrameUs = publishedTimestampUs;
      lastFrameMonotonicUs = monotonicNowUs();
    },
  };
}

// =============================================================================
// Implementation
// =============================================================================

/** Snapshot-context updates driven by the codec's async callbacks. */
type InternalMessage =
  | { type: 'chunk-output'; byteLength: number; keyframe: boolean; timestampUs: number }
  | { type: 'codec-error' };

/** Owned copy of a decoder `description` for per-keyframe LOC carriage. */
function copyDescription(description: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  return Uint8Array.from(view);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function createEncoderActor<Config, Frame extends { close(): void; timestamp: number }>(options: {
  /** Codec kind — governs only which LOC Config property carries extradata. */
  track: 'video' | 'audio';
  sink: EncodedChunkSink;
  /** Builds the codec adapter; `output`/`error` are the codec callbacks. */
  create(callbacks: {
    output: (chunk: EncodedChunkLike, metadata?: EncoderOutputMetadata) => void;
    error: (error: unknown) => void;
  }): EncoderInstance<Config, Frame>;
  maxQueueDepth?: number;
  onError?: (error: unknown) => void;
  nowUs?: () => number;
  timeline?: TrackTimeline;
  sinkTrack?: EncodedChunkSinkMeta['track'];
}): EncoderActor<Config, Frame> {
  const { track, sink, onError } = options;
  const sinkTrack = options.sinkTrack ?? (track === 'video' ? 'camera' : 'audio');
  const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  const timeline = options.timeline ?? createTrackTimeline({ nowUs: options.nowUs });

  type Message = EncoderMessage<Config, Frame> | InternalMessage;
  type Ctx = HandlerContext<EncoderActorUserState, EncoderActorCounters, () => SerialRunner>;

  // Assigned right after createMachineActor returns; the codec callbacks
  // only fire asynchronously, well after construction completes.
  let inner: MessageActor<EncoderActorState, EncoderActorCounters, Message> | undefined;

  // Latest codec extradata seen on the output metadata. Publishers repeat
  // the config on every keyframe (the LOC Config property), so the most
  // recent description is carried until the codec reports a new one.
  // Plumbing for the output callback, not actor bookkeeping — stats
  // consumers have no use for it, so it stays out of the snapshot.
  let latestConfig: Uint8Array | undefined;

  // Capture-clock → published-domain rebase constant (see the module
  // doc), pinned by the timeline. Anchored on the first frame the codec
  // accepts — the input side, where delivery lags capture by less than a
  // frame, not the output side, where codec queueing would fold encode
  // latency into the timeline. Actor lifetime matches
  // capture-stream lifetime (`setupEncoderActors` rebuilds actors per
  // stream), so one anchor per clock domain holds; a mid-stream
  // reconfigure keeps it.
  let timestampOffsetUs: number | undefined;

  const instance = options.create({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description !== undefined) latestConfig = copyDescription(description);
      const keyframe = chunk.type === 'key';
      // Codecs carry input timestamps through to their chunks, so the
      // input-anchored offset applies exactly.
      const timestampUs = chunk.timestamp + (timestampOffsetUs ?? 0);
      const rebased: EncodedChunkLike = {
        type: chunk.type,
        timestamp: timestampUs,
        byteLength: chunk.byteLength,
        copyTo: (destination) => chunk.copyTo(destination),
      };
      // The config property is kind-specific on the wire (loc-04 §2.3.2.1
      // vs §2.3.3.1); the actor's track kind picks which one to label.
      const packaged = packageLocFrame(
        rebased,
        latestConfig === undefined
          ? {}
          : track === 'video'
            ? { videoConfig: latestConfig }
            : { audioConfig: latestConfig }
      );
      sink(packaged, { keyframe, timestampUs, byteLength: chunk.byteLength, track: sinkTrack });
      inner?.send({ type: 'chunk-output', byteLength: chunk.byteLength, keyframe, timestampUs });
    },
    error: (error) => {
      onError?.(error);
      inner?.send({ type: 'codec-error' });
    },
  });

  const configure = (msg: { config: Config }, { transition }: Ctx): void => {
    try {
      // The cached extradata belongs to the outgoing config. WebCodecs
      // emits a fresh `decoderConfig` on the first output after
      // configure(), so invalidating here can never leave a keyframe
      // carrying a stale description for the new config.
      latestConfig = undefined;
      instance.configure(msg.config);
      transition('encoding');
    } catch (error) {
      onError?.(error);
    }
  };

  /** A fatal codec error already closed the codec; mirror it. */
  const onCodecError = (_: InternalMessage, { transition, runner }: Ctx): void => {
    runner.abortAll();
    instance.close();
    transition('closed');
  };

  /** Frames that arrive in a state that cannot encode are still owned. */
  const closeFrame = (msg: { frame: Frame }): void => {
    msg.frame.close();
  };

  inner = createMachineActor<EncoderActorUserState, EncoderActorCounters, Message, () => SerialRunner>({
    runner: () => new SerialRunner(),
    initial: 'unconfigured',
    context: { encodedFrames: 0, encodedBytes: 0, droppedFrames: 0, keyframes: 0, lastTimestampUs: Number.NaN },
    states: {
      unconfigured: {
        on: {
          configure,
          encode: closeFrame,
          close: (_, { transition }) => {
            instance.close();
            transition('closed');
          },
          'codec-error': onCodecError,
        },
      },
      encoding: {
        on: {
          // Mid-stream reconfigure (WebCodecs allows it on a configured codec).
          configure,
          encode: (msg, { context, setContext }) => {
            const keyFrame = msg.keyFrame === true;
            if (!keyFrame && instance.encodeQueueSize > maxQueueDepth) {
              // A backpressure-dropped frame still advances the capture
              // clock the next epoch resumes from — but only an anchored
              // epoch has a domain to record it in.
              if (timestampOffsetUs !== undefined) timeline.recordFrame(msg.frame.timestamp + timestampOffsetUs);
              msg.frame.close();
              setContext({ ...context, droppedFrames: context.droppedFrames + 1 });
              return;
            }
            try {
              instance.encode(msg.frame, keyFrame);
              // Anchored (and recorded) only once the codec ACCEPTS the
              // frame: a synchronous encode failure must not commit an
              // anchor — or feed the shared timeline — for a frame that
              // never entered the stream; the next accepted frame anchors
              // instead. Codec outputs are queued asynchronously, so the
              // offset is always in place before this frame's chunk emerges.
              if (timestampOffsetUs === undefined) timestampOffsetUs = timeline.anchorOffsetUs(msg.frame.timestamp);
              timeline.recordFrame(msg.frame.timestamp + timestampOffsetUs);
            } catch (error) {
              onError?.(error);
            } finally {
              msg.frame.close();
            }
          },
          flush: (_, { runner }) => {
            runner.schedule(new Task(() => instance.flush())).catch((error) => {
              // Aborted flushes (close/destroy during drain) are expected.
              if (!isAbortError(error)) onError?.(error);
            });
          },
          close: (_, { transition, runner }) => {
            runner.abortAll();
            instance.close();
            transition('closed');
          },
          'chunk-output': (msg, { context, setContext }) => {
            setContext({
              ...context,
              encodedFrames: context.encodedFrames + 1,
              encodedBytes: context.encodedBytes + msg.byteLength,
              keyframes: context.keyframes + (msg.keyframe ? 1 : 0),
              lastTimestampUs: msg.timestampUs,
            });
          },
          'codec-error': onCodecError,
        },
      },
      closed: {
        on: {
          encode: closeFrame,
        },
      },
    },
  });

  const actor = inner;
  return {
    get snapshot() {
      return actor.snapshot;
    },
    send(message: EncoderMessage<Config, Frame>): void {
      actor.send(message);
    },
    destroy(): void {
      instance.close();
      actor.destroy();
    },
  };
}
