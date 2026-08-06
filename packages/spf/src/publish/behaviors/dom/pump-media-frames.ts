/**
 * **Pump capture-track frames into the encoder actors.** Three
 * independent read loops — camera, screen, mic — each spawned while its
 * own stream/actor pair (`context.{cameraStream,screenStream,micStream}`
 * + the matching encoder actor) is live, using one
 * `MediaStreamTrackProcessor` per loop and dispatching every frame as an
 * `encode` message. The two video loops force `keyFrame: true` on the
 * group cadence (`config.groupDurationSec`, default 2 s each, tracked
 * independently per kind so a screen share starting mid-session starts
 * its own group sequence rather than inheriting the camera's), computed
 * from frame timestamps rather than wall clock so paused/hidden capture
 * doesn't skew GoP boundaries. Loops abort on state exit, stream change,
 * or teardown.
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
import { effect } from '../../../core/signals/effect';
import { peek, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import type { AudioEncoderActor } from '../../actors/dom/audio-encoder';
import type { EncoderActor } from '../../actors/dom/encoder-actor';
import type { VideoEncoderActor } from '../../actors/dom/video-encoder';
import type { PublishErrorFacts } from './acquire-capture-source';

export interface PumpMediaFramesState {
  publishError?: PublishErrorFacts | undefined;
}

export interface PumpMediaFramesContext {
  cameraStream?: MediaStream | undefined;
  screenStream?: MediaStream | undefined;
  micStream?: MediaStream | undefined;
  cameraEncoderActor?: VideoEncoderActor | undefined;
  screenEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
}

export interface PumpMediaFramesConfig {
  /** Forced-keyframe cadence in seconds; each GoP becomes one MOQT group. */
  groupDurationSec?: number;
}

export const DEFAULT_GROUP_DURATION_SEC = 2;

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
    cameraStream: ReadonlySignal<PumpMediaFramesContext['cameraStream']>;
    screenStream: ReadonlySignal<PumpMediaFramesContext['screenStream']>;
    micStream: ReadonlySignal<PumpMediaFramesContext['micStream']>;
    cameraEncoderActor: ReadonlySignal<PumpMediaFramesContext['cameraEncoderActor']>;
    screenEncoderActor: ReadonlySignal<PumpMediaFramesContext['screenEncoderActor']>;
    audioEncoderActor: ReadonlySignal<PumpMediaFramesContext['audioEncoderActor']>;
  };
  config?: PumpMediaFramesConfig;
}): () => void {
  const groupDurationUs = (config.groupDurationSec ?? DEFAULT_GROUP_DURATION_SEC) * 1_000_000;

  function runVideoPump(
    stream: ReadonlySignal<MediaStream | undefined>,
    actor: ReadonlySignal<VideoEncoderActor | undefined>
  ): () => void {
    return effect(() => {
      const mediaStream = stream.get();
      const videoActor = actor.get();
      if (!mediaStream || !videoActor) return;

      if (typeof MediaStreamTrackProcessor === 'undefined') {
        state.publishError.set({
          code: 'encode',
          message: 'MediaStreamTrackProcessor is not supported in this environment.',
        });
        return;
      }

      const videoTrack = mediaStream.getVideoTracks()[0];
      if (!videoTrack) return;

      const reportError = (error: unknown) => {
        if (peek(stream) !== mediaStream) return;
        state.publishError.set({
          code: 'encode',
          message: error instanceof Error ? error.message : 'Failed to read frames from a capture track.',
          cause: error,
        });
      };

      try {
        const processor = new MediaStreamTrackProcessor<VideoFrame>({ track: videoTrack });
        return pumpFrames(processor.readable.getReader(), videoActor, reportError, keyframeCadence(groupDurationUs));
      } catch (error) {
        reportError(error);
        return;
      }
    });
  }

  function runAudioPump(): () => void {
    return effect(() => {
      const mediaStream = context.micStream.get();
      const audioActor = context.audioEncoderActor.get();
      if (!mediaStream || !audioActor) return;

      if (typeof MediaStreamTrackProcessor === 'undefined') {
        state.publishError.set({
          code: 'encode',
          message: 'MediaStreamTrackProcessor is not supported in this environment.',
        });
        return;
      }

      const audioTrack = mediaStream.getAudioTracks()[0];
      if (!audioTrack) return;

      const reportError = (error: unknown) => {
        if (peek(context.micStream) !== mediaStream) return;
        state.publishError.set({
          code: 'encode',
          message: error instanceof Error ? error.message : 'Failed to read frames from a capture track.',
          cause: error,
        });
      };

      try {
        const processor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
        // No cadence: every audio frame is independently decodable and
        // starts its own MOQT group downstream.
        return pumpFrames(processor.readable.getReader(), audioActor, reportError);
      } catch (error) {
        reportError(error);
        return;
      }
    });
  }

  const disposers = [
    runVideoPump(context.cameraStream, context.cameraEncoderActor),
    runVideoPump(context.screenStream, context.screenEncoderActor),
    runAudioPump(),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}

export const pumpMediaFrames = defineBehavior({
  stateKeys: ['publishError'],
  contextKeys: ['cameraStream', 'screenStream', 'micStream', 'cameraEncoderActor', 'screenEncoderActor', 'audioEncoderActor'],
  setup: pumpMediaFramesSetup,
});
