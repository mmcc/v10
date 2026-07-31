/**
 * **Own the per-track publisher actors for the publish session.** While
 * the publish session is `ready`/`live` and `state.activeEncodings` names
 * at least one encoding, offers the tracks to the peer (PUBLISH via the
 * session driver — catalog first, then video/audio as active) and creates
 * one `TrackPublisherActor` per track bound to the session's
 * `openUniStream`, publishing the `catalogTrackPublisher` /
 * `videoTrackPublisher` / `audioTrackPublisher` context slots. The
 * catalog and audio publishers run in `groupPerFrame` mode (every object
 * is a random-access point per LOC/MSF); video groups follow keyframes.
 *
 * Cluster-owner reactor per the per-type setup-actor convention: the
 * encoder chunk router (the engine's default `chunkSink`) and
 * `deriveCatalog` only read the slots — they never create the actors. On
 * session loss, encoding change, or teardown the actors are destroyed in
 * reverse creation order, each track gets its PUBLISH_DONE
 * (`handle.done()`), and the slots are cleared.
 *
 * Sole writer of the three track-publisher context slots; co-writer of
 * `state.publishError` (track stream failures only).
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import { PUBLISH_DONE_STATUS } from '../../network/moqt/control-messages';
import type { TrackPublisherActor } from '../actors/track-publisher';
import { createTrackPublisherActor } from '../actors/track-publisher';
import type { PublishEndpoint, PublishedTrack, PublishSessionActor } from '../session/publish-session';
import type { SessionPublishErrorFacts } from './open-publish-session';

/**
 * Structural mirror of `behaviors/dom/probe-encoder-support.ts`'s
 * `ActiveEncodingsFacts` (DOM-bound behavior, so not importable here;
 * the WebCodecs config types themselves live in the WebWorker lib) —
 * keep identical.
 */
export interface ActiveEncodingsFacts {
  video?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}

/** MSF-conventional track names for the single-rendition publisher. */
export const CATALOG_TRACK_NAME = 'catalog';
export const VIDEO_TRACK_NAME = 'video';
export const AUDIO_TRACK_NAME = 'audio';

export interface SetupTrackPublishersState {
  activeEncodings?: ActiveEncodingsFacts;
  endpoint?: PublishEndpoint | undefined;
  publishError?: SessionPublishErrorFacts | undefined;
}

export interface SetupTrackPublishersContext {
  publishSessionActor?: PublishSessionActor | undefined;
  catalogTrackPublisher?: TrackPublisherActor | undefined;
  videoTrackPublisher?: TrackPublisherActor | undefined;
  audioTrackPublisher?: TrackPublisherActor | undefined;
}

export interface SetupTrackPublishersConfig {
  /** Groups the transport may fall behind before dropping to the keyframe. */
  maxQueuedGroups?: number;
}

type SetupTrackPublishersFsmState = 'preconditions-unmet' | 'publishers-ready';

function hasEncoding(encodings: ActiveEncodingsFacts | undefined): boolean {
  return Boolean(encodings && (encodings.video || encodings.audio));
}

function setupTrackPublishersSetup({
  state,
  context,
  config = {},
}: {
  state: {
    activeEncodings: ReadonlySignal<SetupTrackPublishersState['activeEncodings']>;
    endpoint: ReadonlySignal<SetupTrackPublishersState['endpoint']>;
    publishError: Signal<SetupTrackPublishersState['publishError']>;
  };
  context: {
    publishSessionActor: ReadonlySignal<SetupTrackPublishersContext['publishSessionActor']>;
    catalogTrackPublisher: Signal<SetupTrackPublishersContext['catalogTrackPublisher']>;
    videoTrackPublisher: Signal<SetupTrackPublishersContext['videoTrackPublisher']>;
    audioTrackPublisher: Signal<SetupTrackPublishersContext['audioTrackPublisher']>;
  };
  config?: SetupTrackPublishersConfig;
}): Reactor<SetupTrackPublishersFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<SetupTrackPublishersFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => {
      const actor = context.publishSessionActor.get();
      const status = actor?.snapshot.get().context.status;
      return (status === 'ready' || status === 'live') &&
        hasEncoding(state.activeEncodings.get()) &&
        state.endpoint.get()
        ? 'publishers-ready'
        : 'preconditions-unmet';
    },
    states: {
      'preconditions-unmet': {},

      'publishers-ready': {
        // effects (not entry) so a session or activeEncodings identity
        // change rebuilds the cluster through the cleanup.
        effects: () => {
          // Tracked: identities only. The snapshot is read untracked —
          // subscriber-count churn must not rebuild the publishers.
          const actor = context.publishSessionActor.get()!;
          const encodings = state.activeEncodings.get()!;
          const endpoint = state.endpoint.get()!;
          const session = peek(actor.snapshot).context.session;
          if (!session) return;

          const namespace = endpoint.namespace;
          const parameters = actor.getAuthParameters();
          const onError = (error: unknown) => {
            state.publishError.set({
              code: 'transport',
              message: error instanceof Error ? error.message : 'Publishing a track stream failed.',
              cause: error,
            });
          };

          const makeTrack = (
            trackName: string,
            groupPerFrame: boolean
          ): { handle: PublishedTrack; publisher: TrackPublisherActor } => {
            const handle = session.publishTrack({ trackNamespace: namespace, trackName, parameters });
            const publisher = createTrackPublisherActor({
              openUniStream: () => session.openUniStream(),
              trackAlias: handle.trackAlias,
              groupPerFrame,
              maxQueuedGroups: config.maxQueuedGroups,
              onError,
            });
            return { handle, publisher };
          };

          const created: { handle: PublishedTrack; publisher: TrackPublisherActor }[] = [];
          const catalog = makeTrack(CATALOG_TRACK_NAME, true);
          created.push(catalog);
          context.catalogTrackPublisher.set(catalog.publisher);
          if (encodings.video) {
            const video = makeTrack(VIDEO_TRACK_NAME, false);
            created.push(video);
            context.videoTrackPublisher.set(video.publisher);
          }
          if (encodings.audio) {
            const audio = makeTrack(AUDIO_TRACK_NAME, true);
            created.push(audio);
            context.audioTrackPublisher.set(audio.publisher);
          }

          // Reverse creation order so frame routing quiesces media before
          // the catalog track (the subscription anchor) announces done.
          // The session behavior's close() drain keeps the transport open
          // for a bounded window, so the PUBLISH_DONE written here reaches
          // the peer even when this cleanup runs as part of session
          // teardown (see the composition-order note in the moq engine).
          return () => {
            context.audioTrackPublisher.set(undefined);
            context.videoTrackPublisher.set(undefined);
            context.catalogTrackPublisher.set(undefined);
            for (const { handle, publisher } of [...created].reverse()) {
              // Quiesce: 'end' FINs the open group, then PUBLISH_DONE
              // reports the opened-stream count (draft-19 §10.11 counts
              // data streams OPENED, including reset ones — not just the
              // FINed groups), then destroy() force-ends whatever is left.
              publisher.send({ type: 'end' });
              const streamCount = peek(publisher.snapshot).context.openedGroups;
              handle.done(PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount, '');
              publisher.destroy();
            }
          };
        },
      },
    },
  });
}

export const setupTrackPublishers = defineBehavior({
  stateKeys: ['activeEncodings', 'endpoint', 'publishError'],
  contextKeys: ['publishSessionActor', 'catalogTrackPublisher', 'videoTrackPublisher', 'audioTrackPublisher'],
  setup: setupTrackPublishersSetup,
});
