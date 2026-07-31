/**
 * **Own the encoder actor pair for the active encodings.** While
 * `state.activeEncodings` names at least one encoder config and a
 * `context.captureStream` is live, creates the per-kind encoder actors
 * (`createVideoEncoderActor` / `createAudioEncoderActor`), configures
 * them, and publishes the `videoEncoderActor` / `audioEncoderActor`
 * context slots. On stream release, encoding change, or teardown the
 * actors are destroyed in reverse creation order and the slots cleared.
 *
 * Cluster-owner reactor per the per-type setup-actor convention:
 * downstream behaviors (`pumpMediaFrames` dispatches frames,
 * `trackPublishStats` samples counters) only read the slots — they never
 * create the actors. The work lives in the positive state's `effects:`
 * so an `activeEncodings` or stream identity change rebuilds the cluster
 * through the cleanup.
 *
 * Packaged output routes through `config.chunkSink` (default: no-op —
 * M2's stats read the actor snapshots; M3 points the sink at the MOQT
 * track publishers without touching this behavior).
 *
 * Sole writer of `context.videoEncoderActor` +
 * `context.audioEncoderActor`; co-writer of `state.publishError`
 * (encoder failures only).
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import type { ReadonlySignal, Signal } from '../../../core/signals/primitives';
import type { AudioEncoderActor } from '../../actors/dom/audio-encoder';
import { createAudioEncoderActor } from '../../actors/dom/audio-encoder';
import type { EncodedChunkSink } from '../../actors/dom/encoder-actor';
import type { VideoEncoderActor } from '../../actors/dom/video-encoder';
import { createVideoEncoderActor } from '../../actors/dom/video-encoder';
import type { PublishErrorFacts } from './acquire-capture-source';
import type { ActiveEncodingsFacts } from './probe-encoder-support';

export interface SetupEncoderActorsState {
  activeEncodings?: ActiveEncodingsFacts;
  publishError?: PublishErrorFacts | undefined;
}

export interface SetupEncoderActorsContext {
  captureStream?: MediaStream | undefined;
  videoEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
}

export interface SetupEncoderActorsConfig {
  /** Packaged-chunk destination; defaults to a no-op until M3's transport. */
  chunkSink?: EncodedChunkSink;
  /** Encoder queue depth above which delta frames are dropped. */
  maxEncodeQueueSize?: number;
}

type SetupEncoderActorsFsmState = 'preconditions-unmet' | 'encoders-ready';

const noopSink: EncodedChunkSink = () => undefined;

function hasEncoding(encodings: ActiveEncodingsFacts | undefined): boolean {
  return Boolean(encodings && (encodings.video || encodings.audio));
}

function setupEncoderActorsSetup({
  state,
  context,
  config = {},
}: {
  state: {
    activeEncodings: ReadonlySignal<SetupEncoderActorsState['activeEncodings']>;
    publishError: Signal<SetupEncoderActorsState['publishError']>;
  };
  context: {
    captureStream: ReadonlySignal<SetupEncoderActorsContext['captureStream']>;
    videoEncoderActor: Signal<SetupEncoderActorsContext['videoEncoderActor']>;
    audioEncoderActor: Signal<SetupEncoderActorsContext['audioEncoderActor']>;
  };
  config?: SetupEncoderActorsConfig;
}): Reactor<SetupEncoderActorsFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<SetupEncoderActorsFsmState>({
    initial: 'preconditions-unmet',
    monitor: () =>
      context.captureStream.get() && hasEncoding(state.activeEncodings.get())
        ? 'encoders-ready'
        : 'preconditions-unmet',
    states: {
      'preconditions-unmet': {},

      'encoders-ready': {
        // effects (not entry) so an activeEncodings or stream identity
        // change rebuilds the actor cluster through the cleanup.
        effects: () => {
          // Tracked: either identity changing means new actors.
          const encodings = state.activeEncodings.get()!;
          context.captureStream.get();

          const sink = config.chunkSink ?? noopSink;
          const options = {
            onError: (error: unknown) => {
              state.publishError.set({
                code: 'encode',
                message: error instanceof Error ? error.message : 'Encoding failed.',
                cause: error,
              });
            },
            ...(config.maxEncodeQueueSize !== undefined && { maxQueueDepth: config.maxEncodeQueueSize }),
          };

          let videoActor: VideoEncoderActor | undefined;
          let audioActor: AudioEncoderActor | undefined;
          if (encodings.video) {
            videoActor = createVideoEncoderActor(sink, options);
            videoActor.send({ type: 'configure', config: encodings.video });
            context.videoEncoderActor.set(videoActor);
          }
          if (encodings.audio) {
            audioActor = createAudioEncoderActor(sink, options);
            audioActor.send({ type: 'configure', config: encodings.audio });
            context.audioEncoderActor.set(audioActor);
          }

          // Reverse creation order so downstream dispatch quiesces before
          // the first-created actor's codec tears down.
          return () => {
            audioActor?.destroy();
            context.audioEncoderActor.set(undefined);
            videoActor?.destroy();
            context.videoEncoderActor.set(undefined);
          };
        },
      },
    },
  });
}

export const setupEncoderActors = defineBehavior({
  stateKeys: ['activeEncodings', 'publishError'],
  contextKeys: ['captureStream', 'videoEncoderActor', 'audioEncoderActor'],
  setup: setupEncoderActorsSetup,
});
