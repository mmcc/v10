/**
 * **Pump capture-track frames into the encoder actors.** While encoder
 * actors exist and a capture stream is live, spawns one
 * `MediaStreamTrackProcessor` read loop per encoded kind and dispatches
 * every frame as an `encode` message. Video frames force
 * `keyFrame: true` on the group cadence (`config.groupDurationSec`,
 * default 2 s), computed from frame timestamps rather than wall clock so
 * paused/hidden capture doesn't skew GoP boundaries. Loops abort on state
 * exit, stream change, or teardown.
 *
 * Frame ownership: the encoder actor takes ownership at `send()` and
 * closes on every path. Frames the loop cannot hand off — teardown races,
 * an actor already closed/destroyed — are closed here; no frame outlives
 * its dispatch decision.
 *
 * Pure-dispatcher reactor per the setup-actor convention: it reads the
 * actor slots `setupEncoderActors` owns and sends messages — it never
 * creates actors. Co-writer of `state.publishError` (missing
 * `MediaStreamTrackProcessor` platform support only).
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import type { AudioEncoderActor } from '../../actors/dom/audio-encoder';
import type { EncoderActor } from '../../actors/dom/encoder-actor';
import type { VideoEncoderActor } from '../../actors/dom/video-encoder';
import type { PublishErrorFacts } from './acquire-capture-source';

export interface PumpMediaFramesState {
  publishError?: PublishErrorFacts | undefined;
}

export interface PumpMediaFramesContext {
  captureStream?: MediaStream | undefined;
  videoEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
}

export interface PumpMediaFramesConfig {
  /** Forced-keyframe cadence in seconds; each GoP becomes one MOQT group. */
  groupDurationSec?: number;
}

export const DEFAULT_GROUP_DURATION_SEC = 2;

type PumpMediaFramesFsmState = 'idle' | 'pumping';

/**
 * Timestamp-driven keyframe cadence: fires on the first frame and
 * whenever `groupDurationUs` of media time has elapsed since the last
 * forced key.
 */
function keyframeCadence(groupDurationUs: number): (timestampUs: number) => boolean {
  let lastKeyTimestampUs: number | undefined;
  return (timestampUs) => {
    if (lastKeyTimestampUs !== undefined && timestampUs - lastKeyTimestampUs < groupDurationUs) return false;
    lastKeyTimestampUs = timestampUs;
    return true;
  };
}

/**
 * Read frames until the track ends or the returned cleanup cancels the
 * reader. Every frame is either handed to the actor (which closes it) or
 * closed here.
 */
function pumpFrames<Config, Frame extends { close(): void; timestamp: number }>(
  reader: ReadableStreamDefaultReader<Frame>,
  actor: EncoderActor<Config, Frame>,
  onError: (error: unknown) => void,
  forceKeyframe?: (timestampUs: number) => boolean
): () => void {
  let aborted = false;

  const loop = async () => {
    try {
      while (true) {
        const { done, value: frame } = await reader.read();
        if (done || !frame) return;
        const actorState = peek(actor.snapshot).value;
        if (aborted || actorState === 'closed' || actorState === 'destroyed') {
          frame.close();
          return;
        }
        actor.send({ type: 'encode', frame, keyFrame: forceKeyframe?.(frame.timestamp) === true });
      }
    } catch (error) {
      // Our own cancel() rejects the pending read too, so only a failure
      // that lands while the pump is still live is a real track failure.
      // Swallowing those left the session marked live with a track that
      // silently stopped producing frames.
      if (!aborted) onError(error);
    }
  };
  void loop();

  return () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
}

function pumpMediaFramesSetup({
  state,
  context,
  config = {},
}: {
  state: {
    publishError: Signal<PumpMediaFramesState['publishError']>;
  };
  context: {
    captureStream: ReadonlySignal<PumpMediaFramesContext['captureStream']>;
    videoEncoderActor: ReadonlySignal<PumpMediaFramesContext['videoEncoderActor']>;
    audioEncoderActor: ReadonlySignal<PumpMediaFramesContext['audioEncoderActor']>;
  };
  config?: PumpMediaFramesConfig;
}): Reactor<PumpMediaFramesFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<PumpMediaFramesFsmState>({
    initial: 'idle',
    monitor: () =>
      context.captureStream.get() && (context.videoEncoderActor.get() || context.audioEncoderActor.get())
        ? 'pumping'
        : 'idle',
    states: {
      idle: {},

      pumping: {
        // effects (not entry) so a stream or actor identity change
        // restarts the read loops through the cleanup.
        effects: () => {
          const stream = context.captureStream.get()!;
          const videoActor = context.videoEncoderActor.get();
          const audioActor = context.audioEncoderActor.get();

          if (typeof MediaStreamTrackProcessor === 'undefined') {
            state.publishError.set({
              code: 'encode',
              message: 'MediaStreamTrackProcessor is not supported in this environment.',
            });
            return;
          }

          const cleanups: (() => void)[] = [];
          const groupDurationUs = (config.groupDurationSec ?? DEFAULT_GROUP_DURATION_SEC) * 1_000_000;

          // A track the platform refuses to process (ended, transferred)
          // surfaces as an encode error rather than tearing the effect down.
          const reportError = (error: unknown) => {
            state.publishError.set({
              code: 'encode',
              message: error instanceof Error ? error.message : 'Failed to read frames from a capture track.',
              cause: error,
            });
          };

          const videoTrack = stream.getVideoTracks()[0];
          if (videoActor && videoTrack) {
            try {
              const processor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
              cleanups.push(
                pumpFrames(processor.readable.getReader(), videoActor, reportError, keyframeCadence(groupDurationUs))
              );
            } catch (error) {
              reportError(error);
            }
          }

          const audioTrack = stream.getAudioTracks()[0];
          if (audioActor && audioTrack) {
            try {
              const processor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
              // No cadence: every audio frame is independently decodable
              // and starts its own MOQT group downstream.
              cleanups.push(pumpFrames(processor.readable.getReader(), audioActor, reportError));
            } catch (error) {
              reportError(error);
            }
          }

          return () => {
            for (const dispose of cleanups) dispose();
          };
        },
      },
    },
  });
}

export const pumpMediaFrames = defineBehavior({
  stateKeys: ['publishError'],
  contextKeys: ['captureStream', 'videoEncoderActor', 'audioEncoderActor'],
  setup: pumpMediaFramesSetup,
});
