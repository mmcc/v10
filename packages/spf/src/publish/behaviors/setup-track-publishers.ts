/**
 * **Own the per-track publisher actors for the publish session.** While
 * the publish session is `ready`/`live`, offers the tracks to the peer
 * (PUBLISH via the session driver — catalog first, then video/audio as
 * `state.activeEncodings` names them) and creates one
 * `TrackPublisherActor` per track bound to the session's `openUniStream`,
 * publishing the `catalogTrackPublisher` / `videoTrackPublisher` /
 * `audioTrackPublisher` context slots. The catalog and audio publishers
 * run in `groupPerFrame` mode (every object is a random-access point per
 * LOC/MSF); video groups follow keyframes.
 *
 * Publishers are keyed on **session identity + track names, not encoder
 * identity**: they come up with the first active encoding and then live
 * as long as the session does. A source switch re-probes the encoders —
 * `activeEncodings` clears transiently and returns with a fresh identity —
 * and the PUBLISHed tracks must ride that out: destroying a publisher
 * sends PUBLISH_DONE, which a relay treats as the END of the track,
 * freezing every downstream subscriber. Encoder churn therefore never
 * touches the publishers; a kind that appears later (e.g. audio joining a
 * video-only session) is added additively, and a kind that disappears
 * simply stops receiving frames.
 *
 * Cluster-owner reactor per the per-type setup-actor convention: the
 * encoder chunk router (the engine's default `chunkSink`) and
 * `deriveCatalog` only read the slots — they never create the actors. On
 * session loss, endpoint change, or teardown the actors are destroyed in
 * reverse creation order, each track gets its PUBLISH_DONE
 * (`handle.done()`), and the slots are cleared.
 *
 * Sole writer of the three track-publisher context slots; co-writer of
 * `state.publishError` (track stream failures only).
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal, signal } from '../../core/signals/primitives';
import type { MessageParameters } from '../../network/moqt/control-messages';
import { PUBLISH_DONE_STATUS } from '../../network/moqt/control-messages';
import type { TrackPublisherActor } from '../actors/track-publisher';
import { createTrackPublisherActor } from '../actors/track-publisher';
import type {
  MoqtPublishSession,
  PublishEndpoint,
  PublishedTrack,
  PublishSessionActor,
} from '../session/publish-session';
import type { SessionPublishErrorFacts } from './open-publish-session';

/**
 * Structural mirror of `behaviors/dom/probe-encoder-support.ts`'s
 * `ActiveEncodingsFacts` (DOM-bound behavior, so not importable here;
 * the WebCodecs config types themselves live in the WebWorker lib) —
 * keep identical.
 */
export interface ActiveEncodingsFacts {
  camera?: VideoEncoderConfig;
  screen?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}

/** MSF-conventional track names. `screen` is a name convention, not a
 * formal MSF role field — see the multi-source design record's
 * "Subscriber labeling" decision. */
export const CATALOG_TRACK_NAME = 'catalog';
export const VIDEO_TRACK_NAME = 'video';
export const SCREEN_TRACK_NAME = 'screen';
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
  screenTrackPublisher?: TrackPublisherActor | undefined;
  audioTrackPublisher?: TrackPublisherActor | undefined;
}

export interface SetupTrackPublishersConfig {
  /** Groups the transport may fall behind before dropping to the keyframe. */
  maxQueuedGroups?: number;
}

type SetupTrackPublishersFsmState = 'preconditions-unmet' | 'publishers-ready';

function hasEncoding(encodings: ActiveEncodingsFacts | undefined): boolean {
  return Boolean(encodings && (encodings.camera || encodings.screen || encodings.audio));
}

/**
 * One session's publisher cluster — the shared plumbing between the owner
 * effect (creates and tears it down with the session) and the
 * encoding-sync effect (adds media publishers as kinds appear).
 */
interface PublisherCluster {
  session: MoqtPublishSession;
  namespace: string[];
  parameters: MessageParameters;
  maxQueuedGroups?: number | undefined;
  onError: (error: unknown) => void;
  /** Creation order; teardown quiesces in reverse. */
  created: { handle: PublishedTrack; publisher: TrackPublisherActor }[];
}

function addTrackPublisher(
  cluster: PublisherCluster,
  trackName: string,
  groupPerFrame: boolean,
  slot: Signal<TrackPublisherActor | undefined>
): void {
  const handle = cluster.session.publishTrack({
    trackNamespace: cluster.namespace,
    trackName,
    parameters: cluster.parameters,
  });
  const publisher = createTrackPublisherActor({
    openUniStream: () => cluster.session.openUniStream(),
    trackAlias: handle.trackAlias,
    groupPerFrame,
    maxQueuedGroups: cluster.maxQueuedGroups,
    onError: cluster.onError,
  });
  cluster.created.push({ handle, publisher });
  slot.set(publisher);
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
    screenTrackPublisher: Signal<SetupTrackPublishersContext['screenTrackPublisher']>;
    audioTrackPublisher: Signal<SetupTrackPublishersContext['audioTrackPublisher']>;
  };
  config?: SetupTrackPublishersConfig;
}): Reactor<SetupTrackPublishersFsmState | 'destroying' | 'destroyed'> {
  // Written by the owner effect, tracked by the encoding-sync effect, so
  // a session rebuild re-adds the media publishers the encodings call for.
  const cluster = signal<PublisherCluster | undefined>(undefined);

  return createMachineReactor<SetupTrackPublishersFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => {
      const actor = context.publishSessionActor.get();
      const status = actor?.snapshot.get().context.status;
      if (!((status === 'ready' || status === 'live') && state.endpoint.get())) return 'preconditions-unmet';
      // First encoding brings the cluster up; after that it is latched on
      // the session — a source switch clears `activeEncodings` transiently
      // (re-probe) and the PUBLISHed tracks must survive it. `peek`: our
      // own effect writes the cluster.
      return hasEncoding(state.activeEncodings.get()) || peek(cluster) ? 'publishers-ready' : 'preconditions-unmet';
    },
    states: {
      'preconditions-unmet': {},

      'publishers-ready': {
        effects: [
          // Owner — tracked on session + endpoint identity ONLY, so those
          // rebuild the cluster through the cleanup while encoder churn
          // does not. The snapshot is read untracked — subscriber-count
          // churn must not rebuild the publishers.
          () => {
            const actor = context.publishSessionActor.get()!;
            const endpoint = state.endpoint.get()!;
            const session = peek(actor.snapshot).context.session;
            if (!session) return;

            const next: PublisherCluster = {
              session,
              namespace: endpoint.namespace,
              parameters: actor.getAuthParameters(),
              maxQueuedGroups: config.maxQueuedGroups,
              onError: (error: unknown) => {
                state.publishError.set({
                  code: 'transport',
                  message: error instanceof Error ? error.message : 'Publishing a track stream failed.',
                  cause: error,
                });
              },
              created: [],
            };
            // Catalog first — the subscription anchor every player joins on.
            addTrackPublisher(next, CATALOG_TRACK_NAME, true, context.catalogTrackPublisher);
            cluster.set(next);

            // Reverse creation order so frame routing quiesces media before
            // the catalog track (the subscription anchor) announces done.
            // The session behavior's close() drain keeps the transport open
            // for a bounded window, so the PUBLISH_DONE written here reaches
            // the peer even when this cleanup runs as part of session
            // teardown (see the composition-order note in the moq engine).
            return () => {
              cluster.set(undefined);
              context.audioTrackPublisher.set(undefined);
              context.screenTrackPublisher.set(undefined);
              context.videoTrackPublisher.set(undefined);
              context.catalogTrackPublisher.set(undefined);
              for (const { handle, publisher } of [...next.created].reverse()) {
                // Quiesce: 'end' FINs the open group, then PUBLISH_DONE
                // reports the opened-stream count (draft-19 §10.11 counts
                // data streams OPENED, including reset ones — not just the
                // FINed groups), then destroy() force-ends whatever is left.
                // The synchronous peek is race-free: an open still in
                // flight can only resume on a later microtask, and by then
                // destroy() has run, so that stream is aborted before its
                // header — unattributable to the track and correctly
                // outside the count it just reported.
                publisher.send({ type: 'end' });
                const streamCount = peek(publisher.snapshot).context.openedGroups;
                handle.done(PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount, '');
                publisher.destroy();
              }
            };
          },

          // Encoding sync — tracked on the cluster + `activeEncodings`;
          // adds the media publishers the active encodings call for.
          // Additive on purpose: absent encodings (a mid-switch re-probe,
          // or a screen share that hasn't started yet) change nothing, and
          // a kind that disappears keeps its publisher — ending the track
          // mid-session would PUBLISH_DONE it for every subscriber. Media
          // track order stays camera-video, then screen, then audio.
          () => {
            const current = cluster.get();
            const encodings = state.activeEncodings.get();
            if (!current || !encodings) return;
            if (encodings.camera && peek(context.videoTrackPublisher) === undefined) {
              addTrackPublisher(current, VIDEO_TRACK_NAME, false, context.videoTrackPublisher);
            }
            if (encodings.screen && peek(context.screenTrackPublisher) === undefined) {
              addTrackPublisher(current, SCREEN_TRACK_NAME, false, context.screenTrackPublisher);
            }
            if (encodings.audio && peek(context.audioTrackPublisher) === undefined) {
              addTrackPublisher(current, AUDIO_TRACK_NAME, true, context.audioTrackPublisher);
            }
          },
        ],
      },
    },
  });
}

export const setupTrackPublishers = defineBehavior({
  stateKeys: ['activeEncodings', 'endpoint', 'publishError'],
  contextKeys: [
    'publishSessionActor',
    'catalogTrackPublisher',
    'videoTrackPublisher',
    'screenTrackPublisher',
    'audioTrackPublisher',
  ],
  setup: setupTrackPublishersSetup,
});
