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
  track: 'video' | 'audio';
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
}

export const DEFAULT_MAX_QUEUE_DEPTH = 60;

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

export function createEncoderActor<Config, Frame extends { close(): void }>(options: {
  track: 'video' | 'audio';
  sink: EncodedChunkSink;
  /** Builds the codec adapter; `output`/`error` are the codec callbacks. */
  create(callbacks: {
    output: (chunk: EncodedChunkLike, metadata?: EncoderOutputMetadata) => void;
    error: (error: unknown) => void;
  }): EncoderInstance<Config, Frame>;
  maxQueueDepth?: number;
  onError?: (error: unknown) => void;
}): EncoderActor<Config, Frame> {
  const { track, sink, onError } = options;
  const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;

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

  const instance = options.create({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description !== undefined) latestConfig = copyDescription(description);
      const keyframe = chunk.type === 'key';
      const packaged = packageLocFrame(chunk, latestConfig === undefined ? {} : { config: latestConfig });
      sink(packaged, { keyframe, timestampUs: chunk.timestamp, byteLength: chunk.byteLength, track });
      inner?.send({ type: 'chunk-output', byteLength: chunk.byteLength, keyframe, timestampUs: chunk.timestamp });
    },
    error: (error) => {
      onError?.(error);
      inner?.send({ type: 'codec-error' });
    },
  });

  const configure = (msg: { config: Config }, { transition }: Ctx): void => {
    try {
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
              msg.frame.close();
              setContext({ ...context, droppedFrames: context.droppedFrames + 1 });
              return;
            }
            try {
              instance.encode(msg.frame, keyFrame);
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
