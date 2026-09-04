/**
 * **Own the per-track publisher actors for the publish session.** While the publish session is `ready`/`live`,
 * registers the tracks the peer may subscribe to (catalog first, then the config-declared application data tracks, then
 * camera/screen/audio as `state.activeEncodings` names them) on the session driver's serve registry, and creates one
 * `TrackPublisherActor` per track bound to the session's `openUniStream`, publishing the `catalogTrackPublisher` /
 * `videoTrackPublisher` / `screenTrackPublisher` / `audioTrackPublisher` context slots plus the `dataTrackProducers`
 * record (page-facing `DataTrackProducer` handles wrapping the data tracks' actors — see `PublishDataTrackConfig`). The
 * catalog, audio, and data publishers run in `groupPerFrame` mode (every object is a random-access point per LOC/MSF);
 * video groups follow keyframes. Ingest is announce-and-serve (pull-through): a publisher writes no data until the
 * session binds it to an inbound subscription, so the binding-sync effect mirrors the session actor's `trackBindings`
 * into `bind`/`unbind` messages per kind — and the catalog publisher replays its latest frame on every bind, because
 * catalog frames flow on change and a fresh subscription must not wait for the next one.
 *
 * Registered tracks are keyed on **session identity + track names, not encoder identity**: they come up with the first
 * active encoding and then live as long as the session does. A source switch re-probes the encoders — `activeEncodings`
 * clears transiently and returns with a fresh identity — and the served tracks must ride that out: ending a track
 * mid-session FINs every live subscription, which a relay treats as the END of the track, freezing every downstream
 * subscriber. Encoder churn therefore never touches the publishers; a kind that appears later (e.g. audio joining a
 * video-only session) is added additively, and a kind that disappears simply stops receiving frames.
 *
 * Cluster-owner reactor per the per-type setup-actor convention: the encoder chunk router (the engine's default
 * `chunkSink`) and `deriveCatalog` only read the slots — they never create the actors. On session loss, endpoint
 * change, or teardown the actors are destroyed in reverse creation order, each track's live subscriptions get their
 * clean FIN (`handle.end()`), and the slots are cleared.
 *
 * Sole writer of the track-publisher context slots (the four media slots plus `dataTrackProducers`). Per-stream
 * failures are deliberately not surfaced as `publishError` anymore: under pull-through ingest the peer resets in-flight
 * subgroup streams on every unsubscribe, so a stream failure is ordinary lifecycle — the publishers count it
 * (`droppedGroups`) and genuine transport death surfaces through the session's own `closed`/`failed` path.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal, signal } from '../../core/signals/primitives';
import { LOC_PROPERTY, MICROSECONDS_PER_SECOND } from '../../media/moq/loc';
import { isMediaCatalogRole } from '../../media/moq/parse-catalog';
import type { TrackPublisherActor } from '../actors/track-publisher';
import { createTrackPublisherActor } from '../actors/track-publisher';
import type {
  MoqtPublishSession,
  PublishEndpoint,
  PublishSessionActor,
  RegisteredTrack,
} from '../session/publish-session';

/**
 * Structural mirror of `behaviors/dom/probe-encoder-support.ts`'s `ActiveEncodingsFacts` (DOM-bound behavior, so not
 * importable here; the WebCodecs config types themselves live in the WebWorker lib) — keep identical.
 */
export interface ActiveEncodingsFacts {
  camera?: VideoEncoderConfig;
  screen?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}

/**
 * MSF-conventional track names. `screen` is a name convention, not a formal MSF role field — see the multi-source
 * design record's "Subscriber labeling" decision.
 */
export const CATALOG_TRACK_NAME = 'catalog';
export const VIDEO_TRACK_NAME = 'video';
export const SCREEN_TRACK_NAME = 'screen';
export const AUDIO_TRACK_NAME = 'audio';

/**
 * Publisher priorities for the built-in tracks. Integers from 0 (highest) to 255 (lowest); omitted entries use catalog
 * 0, audio 64, camera 128, and screen 192. Applied to both MoQ subgroup headers and local WebTransport send order.
 * Relay scheduling also depends on subscriber priorities and the relay's policy.
 */
export interface PublishTrackPriorities {
  catalog?: number;
  audio?: number;
  camera?: number;
  screen?: number;
}

const DEFAULT_TRACK_PRIORITIES = { catalog: 0, audio: 64, camera: 128, screen: 192 } as const;
const DEFAULT_DATA_TRACK_PRIORITY = 128;

function resolvePriority(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;

  if (Number.isInteger(value) && value >= 0 && value <= 255) return value;

  if (__DEV__) console.warn(`[moq-publish] track priority must be an integer from 0 to 255; using ${fallback}`);

  return fallback;
}

/** Track names the engine publishes itself — refused for data tracks. */
const RESERVED_TRACK_NAMES: ReadonlySet<string> = new Set([
  CATALOG_TRACK_NAME,
  VIDEO_TRACK_NAME,
  SCREEN_TRACK_NAME,
  AUDIO_TRACK_NAME,
]);

/**
 * One application data track published on the broadcast beside the media — timed metadata, overlays, or any other
 * page-produced payload stream that must live on the _same_ broadcast as the media tracks (a second publisher
 * announcing the same namespace would be two origins competing for one broadcast name).
 */
export interface PublishDataTrackConfig {
  /**
   * Track name on the broadcast. The engine-owned names (`catalog`, `video`, `screen`, `audio`) are reserved; a config
   * naming one (or duplicating another data track) is dropped with a dev warning.
   */
  name: string;
  /** Publisher priority, 0 (highest) to 255 (lowest). Defaults to 128; invalid values use the default. */
  priority?: number;
  /**
   * MSF role label emitted on the track's catalog entry (e.g. `'data'`). Any non-media value keeps the track out of a
   * subscriber's renderable set; omitted, the entry carries no role and is classified the same way from its absent
   * media fields. A media role (`'video'`, `'audio'`, `'caption'`, …) is refused — it would advertise the track as
   * renderable media with no codec — and stripped with a dev warning; the track still publishes.
   */
  role?: string;
  /**
   * Re-send the latest payload as a fresh group whenever a subscription binds — for state-shaped tracks (an overlay
   * showing current text) where a late subscriber must not wait for the next change. Leave off (the default) for
   * event-shaped metadata, where replaying a stale event would be a duplicate delivery.
   */
  replayLastOnSubscribe?: boolean;
}

/**
 * The page-facing write handle for one application data track. Payloads are LOC-packaged (Timestamp + Timescale object
 * properties) and each becomes its own single-object MOQT group, so every payload is a random-access point. Under
 * pull-through ingest a payload published while no subscription is bound is dropped (or retained for replay when the
 * track was configured with `replayLastOnSubscribe`).
 */
export interface DataTrackProducer {
  readonly trackName: string;
  /**
   * Publish one payload. `timestampUs` defaults to the wall clock in microseconds (`Date.now() * 1000`); pages aligning
   * payloads with the media capture timeline should pass their own.
   */
  publish(payload: Uint8Array, options?: { timestampUs?: number }): void;
}

/**
 * Resolve data-track configs into the set the engine actually publishes: names colliding with an engine-owned track or
 * an earlier data track are dropped, names unusable as record keys (empty, or an `Object.prototype` member such as
 * `__proto__`/`constructor` — the producers record and the session's `trackBindings` are name-keyed plain objects) are
 * dropped, and a media catalog role is stripped from an otherwise valid track (see `PublishDataTrackConfig.role`).
 * Shared by this behavior (the serve registry) and `deriveCatalog` (the advertisement) so the catalog never names a
 * track the session refused to register; only the registry owner passes `warn`, so each dropped config reports once per
 * engine.
 */
export function resolveDataTracks(
  configs: readonly PublishDataTrackConfig[] | undefined,
  { warn = false }: { warn?: boolean } = {}
): readonly PublishDataTrackConfig[] {
  const resolved: PublishDataTrackConfig[] = [];
  const taken = new Set(RESERVED_TRACK_NAMES);
  const report = (message: string) => {
    if (warn && __DEV__) console.warn(`[moq-publish] ${message}`);
  };

  for (const track of configs ?? []) {
    if (taken.has(track.name)) {
      report(`data track "${track.name}" collides with a reserved or duplicate track name and was dropped`);
      continue;
    }

    // `name in {}` catches every Object.prototype member, including the
    // `__proto__` accessor: assigning such a name on a plain record would
    // mutate its prototype or shadow an inherited member, and reading it
    // from `trackBindings` before any subscription would return the
    // inherited value instead of "unbound".
    if (track.name === '' || track.name in {}) {
      report(`data track name "${track.name}" is not usable as a track key and was dropped`);
      continue;
    }

    taken.add(track.name);

    if (track.role !== undefined && isMediaCatalogRole(track.role)) {
      // A media role would land the entry in a subscriber's renderable
      // set as an undecodable track — the track publishes, its media
      // label does not.
      report(`data track "${track.name}" declares media role "${track.role}"; the role was dropped`);
      const { role: _role, ...withoutRole } = track;

      resolved.push(withoutRole);
      continue;
    }

    resolved.push(track);
  }

  return resolved;
}

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
  /**
   * Producer handles for the configured data tracks, keyed by track name. Present while the publisher cluster is up;
   * replaced wholesale when a session rebuild recreates the cluster.
   */
  dataTrackProducers?: Readonly<Record<string, DataTrackProducer>> | undefined;
}

export interface SetupTrackPublishersConfig {
  /** Built-in track priorities; lower numbers are served first. */
  trackPriorities?: PublishTrackPriorities;
  /** Groups the transport may fall behind before dropping to the keyframe. */
  maxQueuedGroups?: number;
  /**
   * Application data tracks published on the broadcast beside the media. Beside, not instead: the publisher cluster
   * comes up with the first active media encoding, so a broadcast with data tracks and no media source publishes
   * nothing — a data-only broadcast is out of scope.
   */
  dataTracks?: PublishDataTrackConfig[];
}

type SetupTrackPublishersFsmState = 'preconditions-unmet' | 'publishers-ready';

function hasEncoding(encodings: ActiveEncodingsFacts | undefined): boolean {
  return Boolean(encodings && (encodings.camera || encodings.screen || encodings.audio));
}

/**
 * One session's publisher cluster — the shared plumbing between the owner effect (creates and tears it down with the
 * session), the encoding-sync effect (adds media publishers as kinds appear), and the binding-sync effect (mirrors
 * subscription bindings into the actors).
 */
interface PublisherCluster {
  session: MoqtPublishSession;
  namespace: string[];
  maxQueuedGroups?: number | undefined;
  priorities: Required<PublishTrackPriorities>;
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
  options: { groupPerFrame: boolean; replayLastGroupOnBind?: boolean; priority: number }
): TrackPublisherActor {
  const publisher = createTrackPublisherActor({
    // WebTransport orders larger values first. Keep all media below the
    // default order (0) of control/request streams so congestion cannot
    // starve the signaling needed to stop or change a subscription.
    openUniStream: () => cluster.session.openUniStream({ sendOrder: -1 - options.priority }),
    priority: options.priority,
    groupPerFrame: options.groupPerFrame,
    replayLastGroupOnBind: options.replayLastGroupOnBind === true,
    maxQueuedGroups: cluster.maxQueuedGroups,
  });
  const handle = cluster.session.registerTrack({
    trackNamespace: cluster.namespace,
    trackName,
    // The publisher owns the Largest Object it has written; the session
    // reads it here to report LARGEST_OBJECT in SUBSCRIBE_OK (§10.2.17).
    getLargestObject: () => {
      const { largestGroupId, largestObjectId } = publisher.snapshot.get().context;

      return largestGroupId >= 0 ? { group: largestGroupId, object: largestObjectId } : undefined;
    },
  });

  cluster.created.push({ handle, publisher, boundAlias: undefined });
  return publisher;
}

/**
 * Wrap a data track's publisher actor as the page-facing producer: LOC packaging (Timestamp + Timescale in the
 * publisher's microsecond timescale) applied here so pages hand over raw payload bytes only.
 */
function toDataTrackProducer(trackName: string, publisher: TrackPublisherActor): DataTrackProducer {
  return {
    trackName,
    publish(payload, options = {}) {
      const timestampUs = options.timestampUs ?? Date.now() * 1000;

      publisher.send({
        type: 'frame',
        payload,
        properties: [
          { type: LOC_PROPERTY.TIMESTAMP, value: timestampUs },
          { type: LOC_PROPERTY.TIMESCALE, value: MICROSECONDS_PER_SECOND },
        ],
        keyframe: true,
        timestampUs,
      });
    },
  };
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
    dataTrackProducers: Signal<SetupTrackPublishersContext['dataTrackProducers']>;
  };
  config?: SetupTrackPublishersConfig;
}): Reactor<SetupTrackPublishersFsmState | 'destroying' | 'destroyed'> {
  // Config-declared and session-independent — resolved once so a rebuilt
  // cluster registers the same names the catalog advertises. This is the
  // warning call site: `deriveCatalog` resolves the same configs silently.
  const dataTracks = resolveDataTracks(config.dataTracks, { warn: true });

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
              priorities: {
                catalog: resolvePriority(config.trackPriorities?.catalog, DEFAULT_TRACK_PRIORITIES.catalog),
                audio: resolvePriority(config.trackPriorities?.audio, DEFAULT_TRACK_PRIORITIES.audio),
                camera: resolvePriority(config.trackPriorities?.camera, DEFAULT_TRACK_PRIORITIES.camera),
                screen: resolvePriority(config.trackPriorities?.screen, DEFAULT_TRACK_PRIORITIES.screen),
              },
              created: [],
            };

            // Catalog first — the subscription anchor every player joins on.
            context.catalogTrackPublisher.set(
              addTrackPublisher(next, CATALOG_TRACK_NAME, {
                priority: next.priorities.catalog,
                groupPerFrame: true,
                replayLastGroupOnBind: true,
              })
            );
            // Application data tracks ride the cluster with the catalog:
            // config-declared rather than encoder-gated, so they come up
            // with the session and live exactly as long as it does.
            const producers: Record<string, DataTrackProducer> = {};

            for (const track of dataTracks) {
              const publisher = addTrackPublisher(next, track.name, {
                priority: resolvePriority(track.priority, DEFAULT_DATA_TRACK_PRIORITY),
                groupPerFrame: true,
                replayLastGroupOnBind: track.replayLastOnSubscribe,
              });

              producers[track.name] = toDataTrackProducer(track.name, publisher);
            }

            context.dataTrackProducers.set(dataTracks.length > 0 ? producers : undefined);
            cluster.set(next);

            // Reverse creation order so frame routing quiesces media before
            // the catalog track (the subscription anchor) ends. The session
            // behavior's close() drain keeps the transport open for a
            // bounded window, so the subscription FINs written here reach
            // the peer even when this cleanup runs as part of session
            // teardown (see the composition-order note in the moq engine).
            return () => {
              cluster.set(undefined);
              context.dataTrackProducers.set(undefined);
              context.audioTrackPublisher.set(undefined);
              context.screenTrackPublisher.set(undefined);
              context.videoTrackPublisher.set(undefined);
              context.catalogTrackPublisher.set(undefined);

              for (const { handle, publisher } of [...next.created].reverse()) {
                // Quiesce: 'end' FINs the open group, then the track's
                // live subscriptions get their clean stream FIN (the
                // clean track end — no trailing message; a relay
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
              context.videoTrackPublisher.set(
                addTrackPublisher(current, VIDEO_TRACK_NAME, {
                  groupPerFrame: false,
                  priority: current.priorities.camera,
                })
              );
            }

            if (encodings.screen && peek(context.screenTrackPublisher) === undefined) {
              context.screenTrackPublisher.set(
                addTrackPublisher(current, SCREEN_TRACK_NAME, {
                  groupPerFrame: false,
                  priority: current.priorities.screen,
                })
              );
            }

            if (encodings.audio && peek(context.audioTrackPublisher) === undefined) {
              context.audioTrackPublisher.set(
                addTrackPublisher(current, AUDIO_TRACK_NAME, {
                  groupPerFrame: true,
                  priority: current.priorities.audio,
                })
              );
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
    'dataTrackProducers',
  ],
  setup: setupTrackPublishersSetup,
});
