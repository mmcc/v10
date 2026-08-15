/**
 * **Own the encoder actor for each active encoding.** Three independent
 * clusters-of-one — camera, screen, mic — each running while its own
 * `state.activeEncodings.{camera,screen,audio}` names a config and the
 * matching capture stream (`context.{cameraStream,screenStream,micStream}`)
 * is live: creates the per-kind encoder actor (`createVideoEncoderActor`
 * for camera/screen, `createAudioEncoderActor` for mic), configures it,
 * and publishes the `cameraEncoderActor` / `screenEncoderActor` /
 * `audioEncoderActor` context slot. On stream release, encoding change,
 * or teardown that kind's actor is destroyed and its slot cleared —
 * independently of the other two, so a screen share starting or ending
 * mid-session never touches the camera or mic encoder. Independence rests
 * on the per-kind narrowing below: `activeEncodings` is one merged object,
 * so tracking it whole would make every kind's write everyone's rebuild.
 *
 * Because this behavior owns the rebuilds, it also owns each kind's
 * published-timeline continuity across them: one `TrackTimeline` per kind
 * outlives every actor rebuilt below, so a replacement actor continues
 * the track's clock domain — advanced by the real acquisition gap —
 * instead of opening a fresh wallclock anchor that would step the track's
 * published timestamps against the surviving tracks (the on-wire cause of
 * "audio jumps and A/V drifts after switching mics"; see the
 * `TrackTimeline` doc in `encoder-actor.ts`).
 *
 * Per-type setup-actor convention: downstream behaviors (`pumpMediaFrames`
 * dispatches frames, `trackPublishStats` samples counters) only read the
 * slots — they never create the actors. Unlike `setupTrackPublishers`
 * (whose publishers must survive an encoding disappearing, since
 * destroying one ends the MOQT track for every subscriber), an encoder
 * actor has no such downstream cost — it is destroyed and recreated
 * freely as its kind's source comes and goes.
 *
 * Packaged output routes through `config.chunkSink` (default: no-op).
 *
 * Sole writer of the three encoder-actor context slots; co-writer of
 * `state.publishError` (encoder failures only).
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import { computed, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import type { AudioEncoderActor } from '../../actors/dom/audio-encoder';
import { createAudioEncoderActor } from '../../actors/dom/audio-encoder';
import type { EncodedChunkSink } from '../../actors/dom/encoder-actor';
import { createTrackTimeline } from '../../actors/dom/encoder-actor';
import type { VideoEncoderActor } from '../../actors/dom/video-encoder';
import { createVideoEncoderActor } from '../../actors/dom/video-encoder';
import type { PublishErrorFacts } from './acquire-capture-source';
import type { ActiveEncodingsFacts } from './probe-encoder-support';

export interface SetupEncoderActorsState {
  activeEncodings?: ActiveEncodingsFacts;
  publishError?: PublishErrorFacts | undefined;
}

export interface SetupEncoderActorsContext {
  cameraStream?: MediaStream | undefined;
  screenStream?: MediaStream | undefined;
  micStream?: MediaStream | undefined;
  cameraEncoderActor?: VideoEncoderActor | undefined;
  screenEncoderActor?: VideoEncoderActor | undefined;
  audioEncoderActor?: AudioEncoderActor | undefined;
}

export interface SetupEncoderActorsConfig {
  /** Packaged-chunk destination; defaults to a no-op until the transport stage. */
  chunkSink?: EncodedChunkSink;
  /** Encoder queue depth above which delta frames are dropped. */
  maxEncodeQueueSize?: number;
}

type SetupEncoderActorsFsmState = 'preconditions-unmet' | 'encoder-ready';

const noopSink: EncodedChunkSink = () => undefined;

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
    cameraStream: ReadonlySignal<SetupEncoderActorsContext['cameraStream']>;
    screenStream: ReadonlySignal<SetupEncoderActorsContext['screenStream']>;
    micStream: ReadonlySignal<SetupEncoderActorsContext['micStream']>;
    cameraEncoderActor: Signal<SetupEncoderActorsContext['cameraEncoderActor']>;
    screenEncoderActor: Signal<SetupEncoderActorsContext['screenEncoderActor']>;
    audioEncoderActor: Signal<SetupEncoderActorsContext['audioEncoderActor']>;
  };
  config?: SetupEncoderActorsConfig;
}): () => void {
  const sink = config.chunkSink ?? noopSink;
  const errorOptions = {
    onError: (error: unknown) => {
      state.publishError.set({
        code: 'encode',
        message: error instanceof Error ? error.message : 'Encoding failed.',
        cause: error,
      });
    },
    ...(config.maxEncodeQueueSize !== undefined && { maxQueueDepth: config.maxEncodeQueueSize }),
  };

  /**
   * Narrow the dependency to one kind's entry. `state.activeEncodings` is a
   * merged multi-writer object whose every per-kind write is a FRESH object
   * (`probe-encoder-support.ts`), so a cluster tracking the whole signal
   * would re-run — cleanup first, i.e. destroy a live codec — whenever an
   * unrelated kind resolved or was released: starting a screen share would
   * cut the camera and the mic mid-stream. Those merges spread the previous
   * object, leaving the other kinds' configs reference-identical, so the
   * computed's `Object.is` dedupe stops the notification here.
   */
  const encodingFor = <Kind extends keyof ActiveEncodingsFacts>(kind: Kind) =>
    computed(() => state.activeEncodings.get()?.[kind]);

  function runVideoCluster(
    encodingKey: 'camera' | 'screen',
    stream: ReadonlySignal<MediaStream | undefined>,
    actorSlot: Signal<VideoEncoderActor | undefined>
  ): Reactor<SetupEncoderActorsFsmState | 'destroying' | 'destroyed'> {
    const encoding = encodingFor(encodingKey);
    // Outlives the actors rebuilt in the effects below — the kind's
    // published timeline stays one clock domain across rebuilds.
    const timeline = createTrackTimeline();
    return createMachineReactor<SetupEncoderActorsFsmState>({
      initial: 'preconditions-unmet',
      monitor: () => (stream.get() && encoding.get() ? 'encoder-ready' : 'preconditions-unmet'),
      states: {
        'preconditions-unmet': {},
        'encoder-ready': {
          // effects (not entry) so this kind's OWN config changing rebuilds
          // its actor. Rebuild rather than a mid-stream `configure`: the
          // actor accepts one, but nothing forces a keyframe after it
          // (`encoder-actor.ts` only drops the cached extradata), so the
          // stream would carry deltas coded against the new config — a new
          // codec's, at worst — until the pump's group cadence came round.
          // A fresh actor restarts that cadence, whose first frame is key.
          effects: () => {
            const videoConfig = encoding.get()!;
            stream.get();
            const actor = createVideoEncoderActor(sink, { ...errorOptions, sinkTrack: encodingKey, timeline });
            actor.send({ type: 'configure', config: videoConfig });
            actorSlot.set(actor);
            return () => {
              actor.destroy();
              actorSlot.set(undefined);
            };
          },
        },
      },
    });
  }

  const cameraCluster = runVideoCluster('camera', context.cameraStream, context.cameraEncoderActor);
  const screenCluster = runVideoCluster('screen', context.screenStream, context.screenEncoderActor);

  const audioEncoding = encodingFor('audio');
  // As in `runVideoCluster`: one published timeline across mic rebuilds —
  // the mic is the kind whose capture source is actually switched live.
  const audioTimeline = createTrackTimeline();
  const audioCluster = createMachineReactor<SetupEncoderActorsFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => (context.micStream.get() && audioEncoding.get() ? 'encoder-ready' : 'preconditions-unmet'),
    states: {
      'preconditions-unmet': {},
      'encoder-ready': {
        effects: () => {
          const audioConfig = audioEncoding.get()!;
          context.micStream.get();
          const actor = createAudioEncoderActor(sink, { ...errorOptions, timeline: audioTimeline });
          actor.send({ type: 'configure', config: audioConfig });
          context.audioEncoderActor.set(actor);
          return () => {
            actor.destroy();
            context.audioEncoderActor.set(undefined);
          };
        },
      },
    },
  });

  return () => {
    cameraCluster.destroy();
    screenCluster.destroy();
    audioCluster.destroy();
  };
}

export const setupEncoderActors = defineBehavior({
  stateKeys: ['activeEncodings', 'publishError'],
  contextKeys: [
    'cameraStream',
    'screenStream',
    'micStream',
    'cameraEncoderActor',
    'screenEncoderActor',
    'audioEncoderActor',
  ],
  setup: setupEncoderActorsSetup,
});
