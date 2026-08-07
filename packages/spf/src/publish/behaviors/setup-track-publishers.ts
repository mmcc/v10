/**
 * **Own the per-track publisher actors for the publish session.** While
 * the publish session is `ready`/`live`, registers the tracks the peer
 * may subscribe to (catalog first, then camera/screen/audio as
 * `state.activeEncodings` names them) on the session driver's serve
 * registry, and creates one `TrackPublisherActor` per track bound to the
 * session's `openUniStream`, publishing the `catalogTrackPublisher` /
 * `videoTrackPublisher` / `screenTrackPublisher` / `audioTrackPublisher`
 * context slots. The catalog and audio publishers run in `groupPerFrame`
 * mode (every object is a random-access point per LOC/MSF); video groups
 * follow keyframes. Ingest is announce-and-serve (pull-through): a
 * publisher writes no data until the session binds it to an inbound
 * subscription, so the binding-sync effect mirrors the session actor's
 * `trackBindings` into `bind`/`unbind` messages per kind — and the
 * catalog publisher replays its latest frame on every bind, because
 * catalog frames flow on change and a fresh subscription must not wait
 * for the next one.
 *
 * Registered tracks are keyed on **session identity + track names, not
 * encoder identity**: they come up with the first active encoding and
 * then live as long as the session does. A source switch re-probes the
 * encoders — `activeEncodings` clears transiently and returns with a
 * fresh identity — and the served tracks must ride that out: ending a
 * track mid-session FINs every live subscription, which a relay treats
 * as the END of the track, freezing every downstream subscriber. Encoder
 * churn therefore never touches the publishers; a kind that appears
 * later (e.g. audio joining a video-only session) is added additively,
 * and a kind that disappears simply stops receiving frames.
 *
 * Cluster-owner reactor per the per-type setup-actor convention: the
 * encoder chunk router (the engine's default `chunkSink`) and
 * `deriveCatalog` only read the slots — they never create the actors. On
 * session loss, endpoint change, or teardown the actors are destroyed in
 * reverse creation order, each track's live subscriptions get their
 * clean FIN (`handle.end()`), and the slots are cleared.
 *
 * Sole writer of the four track-publisher context slots. Per-stream
 * failures are deliberately not surfaced as `publishError` anymore:
 * under pull-through ingest the peer resets in-flight subgroup streams
 * on every unsubscribe, so a stream failure is ordinary lifecycle — the
 * publishers count it (`droppedGroups`) and genuine transport death
 * surfaces through the session's own `closed`/`failed` path.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal, signal } from '../../core/signals/primitives';
import type { TrackPublisherActor } from '../actors/track-publisher';
import { createTrackPublisherActor } from '../actors/track-publisher';
import type {
  MoqtPublishSession,
  PublishEndpoint,
  PublishSessionActor,
  RegisteredTrack,
} from '../session/publish-session';

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
 * effect (creates and tears it down with the session), the encoding-sync
 * effect (adds media publishers as kinds appear), and the binding-sync
 * effect (mirrors subscription bindings into the actors).
 */
interface PublisherCluster {
  session: MoqtPublishSession;
  namespace: string[];
  maxQueuedGroups?: number | undefined;
  /** Creation order; teardown quiesces in reverse. */
  created: {
    handle: RegisteredTrack;
    publisher: TrackPublisherActor;
    /** Last binding sent to the publisher — dedupes the snapshot churn. */
    boundAlias: number | undefined;
  }[];
}

function addTrackPublisher(
  cluster: PublisherCluster,
  trackName: string,
  groupPerFrame: boolean,
  slot: Signal<TrackPublisherActor | undefined>
): void {
  const handle = cluster.session.registerTrack({
    trackNamespace: cluster.namespace,
    trackName,
  });
  const publisher = createTrackPublisherActor({
    openUniStream: () => cluster.session.openUniStream(),
    groupPerFrame,
    replayLastGroupOnBind: trackName === CATALOG_TRACK_NAME,
    maxQueuedGroups: cluster.maxQueuedGroups,
  });
  cluster.created.push({ handle, publisher, boundAlias: undefined });
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
  // Written by the owner effect, tracked by the encoding-sync and
  // binding-sync effects, so a session rebuild re-adds the media
  // publishers the encodings call for and re-syncs their bindings.
  const cluster = signal<PublisherCluster | undefined>(undefined);

  return createMachineReactor<SetupTrackPublishersFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => {
      const actor = context.publishSessionActor.get();
      const status = actor?.snapshot.get().context.status;
      if (!((status === 'ready' || status === 'live') && state.endpoint.get())) return 'preconditions-unmet';
      // First encoding brings the cluster up; after that it is latched on
      // the session — a source switch clears `activeEncodings` transiently
      // (re-probe) and the served tracks must survive it. `peek`: our
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
              maxQueuedGroups: config.maxQueuedGroups,
              created: [],
            };
            // Catalog first — the subscription anchor every player joins on.
            addTrackPublisher(next, CATALOG_TRACK_NAME, true, context.catalogTrackPublisher);
            cluster.set(next);

            // Reverse creation order so frame routing quiesces media before
            // the catalog track (the subscription anchor) ends. The session
            // behavior's close() drain keeps the transport open for a
            // bounded window, so the subscription FINs written here reach
            // the peer even when this cleanup runs as part of session
            // teardown (see the composition-order note in the moq engine).
            return () => {
              cluster.set(undefined);
              context.audioTrackPublisher.set(undefined);
              context.screenTrackPublisher.set(undefined);
              context.videoTrackPublisher.set(undefined);
              context.catalogTrackPublisher.set(undefined);
              for (const { handle, publisher } of [...next.created].reverse()) {
                // Quiesce: 'end' FINs the open group, then the track's
                // live subscriptions get their clean stream FIN (the
                // draft-19 track end — no trailing message; a relay
                // aborts the track on any post-SUBSCRIBE_OK byte), then
                // destroy() force-ends whatever is left.
                publisher.send({ type: 'end' });
                handle.end();
                publisher.destroy();
              }
            };
          },

          // Encoding sync — tracked on the cluster + `activeEncodings`;
          // adds the media publishers the active encodings call for.
          // Additive on purpose: absent encodings (a mid-switch re-probe,
          // or a screen share that hasn't started yet) change nothing, and
          // a kind that disappears keeps its publisher — ending the track
          // mid-session would FIN it for every subscriber. Media track
          // order stays camera-video, then screen, then audio.
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

          // Binding sync — tracked on the cluster + the session actor's
          // snapshot; mirrors `trackBindings` (trackName → alias) into
          // `bind`/`unbind` messages so each publisher writes data only
          // while its track has a live subscription. The snapshot churns
          // on unrelated counters too, so sends are deduped per publisher
          // (`boundAlias` lives on the cluster entry and resets with it).
          () => {
            const current = cluster.get();
            const actor = context.publishSessionActor.get();
            if (!current || !actor) return;
            const bindings = actor.snapshot.get().context.trackBindings;
            for (const entry of current.created) {
              const alias = bindings[entry.handle.trackName];
              if (alias === entry.boundAlias) continue;
              entry.boundAlias = alias;
              entry.publisher.send(alias === undefined ? { type: 'unbind' } : { type: 'bind', trackAlias: alias });
            }
          },
        ],
      },
    },
  });
}

export const setupTrackPublishers = defineBehavior({
  stateKeys: ['activeEncodings', 'endpoint'],
  contextKeys: [
    'publishSessionActor',
    'catalogTrackPublisher',
    'videoTrackPublisher',
    'screenTrackPublisher',
    'audioTrackPublisher',
  ],
  setup: setupTrackPublishersSetup,
});
