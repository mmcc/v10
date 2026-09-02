/**
 * **Turn per-type track selection into MoQ subscriptions.** The MoQ analog of `resolve-track` + `load-segments`
 * combined: reacts to `selected{Video,Audio}TrackId` (written by the reused `track-switching` behaviors) and keeps
 * exactly one live `track-subscriber` actor per type in context, feeding the renderers.
 *
 * Switches are **make-before-break**: the new track is subscribed at an MSF time-aligned boundary (`relative-group 0` —
 * groups open with a random-access point, and alternate-group tracks share group numbers, §4.2) while the old
 * subscription keeps playing. Only once the new subscriber has buffered a decodable keyframe-led group
 * (`hasDecodableFrame`) _and_ its oldest frame is due at the playout clock (`currentTime`) does the swap happen: old
 * cancelled, new promoted. That's what prevents playback gaps on ABR/language switches, and it's why each type has a
 * `pending*SubscriberActor` sibling slot — old and new overlap during the handoff.
 *
 *     'preconditions-unmet' → 'session-ready'
 *
 * `'session-ready'` requires the session actor to be ready, the load gate to be open (`loadActivated || preload ===
 * 'auto'` — the same gate as HLS `load-segments`' full-range loading), _and_ media delivery not suspended
 * (`mediaSuspended`, set by `suspend-media-while-paused` when a pause outlives its hold window). The audio variant
 * reads one further gate: `audioSuspended`, the adapter's autoplay-policy deferral — while a playback that began
 * without a user gesture cannot resume its AudioContext, audio delivery waits (video keeps playing on the self-clock)
 * and the unlock rejoins at the live edge. Catalog resolution stays ungated in `resolve-catalog`, so `preload:
 * 'metadata'` still resolves tracks without downloading media — and a suspended pause keeps receiving catalog updates.
 * Closing any gate exits the state and tears both subscribers down; reopening re-subscribes the current selection
 * through the initial-join filters (a live-edge rejoin, not a handoff).
 *
 * Dead-subscription recovery: a subscription can die while its selection stands — the publisher ended it (PUBLISH_DONE
 * on a broadcaster blip), the relay refused it, or the subscriber's stall watchdog gave up. The actor reports that as a
 * terminal snapshot status (`'ended'`/`'error'`); this behavior destroys the dead actor(s) and re-subscribes the same
 * selection at the live edge (the initial-join filter, exactly the suspend/rejoin path) after a capped backoff
 * (`subscribeRetry`). An `'ended'` subscription first plays out its buffered tail — late subgroups keep arriving after
 * PUBLISH_DONE by design — where an `'error'`/stall death has nothing worth draining. Deaths the actor marks
 * `unrecoverable` (permanent rejections, spent auth) are not rejoined at all: the corpse holds its slot until the
 * selection moves. Replacing the actor rides the renderers' existing swap path — decoder reconfigure, clock re-anchor —
 * so a broadcaster restart with reset timestamps re-anchors instead of stalling.
 *
 * Sole writer of its type's `*SubscriberActor` + `pending*SubscriberActor` slots (renderers and latency/bandwidth
 * behaviors only read). Slot reads inside the effect use `peek` — the effect re-fires on selection/session/
 * pending-snapshot changes, plus status _transitions_ of its own actors (equality-gated `computed`s over the slots) and
 * the rejoin timer's tick, not on its own slot writes.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal, signal } from '../../core/signals/primitives';
import type { MoqTrack } from '../../media/moq/parse-catalog';
import { isLiveTrack, type MaybeResolvedPresentation } from '../../media/types';
import { findTrack } from '../../media/utils/tracks';
import type { LocationFilter } from '../../network/moqt/control-messages';
import {
  DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG,
  MAX_SERVER_RETRY_INTERVAL_MS,
  type RetryBackoffConfig,
  resolveRetryBackoffConfig,
  retryDelayMs,
} from '../../network/retry-backoff';
import type { MoqSessionActor } from '../actors/moq-session';
import {
  createTrackSubscriberActor,
  type TrackSubscriberActor,
  type TrackSubscriberStatus,
} from '../actors/track-subscriber';

// ============================================================================
// State / context / config
// ============================================================================

export interface SubscribeSelectedTracksState {
  presentation?: MaybeResolvedPresentation;
  selectedVideoTrackId?: string;
  selectedAudioTrackId?: string;
  preload?: 'auto' | 'metadata' | 'none';
  loadActivated?: boolean;
  /** Sustained-pause gate written by `suspend-media-while-paused`. */
  mediaSuspended?: boolean;
  /**
   * Adapter-written autoplay-policy gate, read by the audio variant only: set while playback started without a user
   * gesture and the suspended AudioContext cannot render audio yet. Same release/rejoin semantics as `mediaSuspended`,
   * scoped to the audio subscription.
   */
  audioSuspended?: boolean;
  /** Playout clock (media seconds) — gates make-before-break promotion. */
  currentTime?: number;
}

export interface SubscribeSelectedTracksContext {
  moqSessionActor?: MoqSessionActor;
  videoSubscriberActor?: TrackSubscriberActor;
  pendingVideoSubscriberActor?: TrackSubscriberActor;
  audioSubscriberActor?: TrackSubscriberActor;
  pendingAudioSubscriberActor?: TrackSubscriberActor;
}

export interface SubscribeSelectedTracksConfig {
  /** Subscriber factory seam for tests. */
  createTrackSubscriber?: typeof createTrackSubscriberActor;
  /**
   * Backoff for re-subscribing a media track whose subscription died (publisher ended it, relay error, data stall).
   * Defaults to {@link DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG}; `maxAttempts: 0` disables recovery.
   */
  subscribeRetry?: Partial<RetryBackoffConfig>;
  /** Data-starvation deadline threaded into each track subscriber — see `CreateTrackSubscriberOptions.stallTimeoutMs`. */
  subscribeStallTimeoutMs?: number;
}

type SelectionKey = 'selectedVideoTrackId' | 'selectedAudioTrackId';
type SubscriberKey = 'videoSubscriberActor' | 'audioSubscriberActor';
type PendingKey = 'pendingVideoSubscriberActor' | 'pendingAudioSubscriberActor';

type FsmState = 'preconditions-unmet' | 'session-ready';

/**
 * Promotion slack: one ~30fps frame in microseconds. The pending subscriber's oldest frame counts as "due" this close
 * to the playout clock so promotion doesn't wait a full clock tick past the boundary.
 */
const PROMOTION_EPSILON_US = 33_000;

interface VariantWiring {
  trackType: 'video' | 'audio';
  selectionKey: SelectionKey;
  subscriberKey: SubscriberKey;
  pendingKey: PendingKey;
  /** Filter for the _initial_ subscription of this type (no handoff). */
  joinFilter: LocationFilter;
}

type VariantStateMap<S extends SelectionKey> = {
  presentation: ReadonlySignal<SubscribeSelectedTracksState['presentation']>;
  preload: ReadonlySignal<SubscribeSelectedTracksState['preload']>;
  loadActivated: ReadonlySignal<SubscribeSelectedTracksState['loadActivated']>;
  mediaSuspended: ReadonlySignal<SubscribeSelectedTracksState['mediaSuspended']>;
  currentTime: ReadonlySignal<SubscribeSelectedTracksState['currentTime']>;
} & { [P in S]: ReadonlySignal<string | undefined> };

type VariantContextMap<Sub extends SubscriberKey, P extends PendingKey> = {
  moqSessionActor: ReadonlySignal<MoqSessionActor | undefined>;
} & { [K in Sub | P]: Signal<TrackSubscriberActor | undefined> };

// ============================================================================
// Shared setup
// ============================================================================

function setupSubscribeSelectedTrack<S extends SelectionKey, Sub extends SubscriberKey, P extends PendingKey>(
  wiring: VariantWiring,
  deps: {
    state: VariantStateMap<S>;
    context: VariantContextMap<Sub, P>;
    config?: SubscribeSelectedTracksConfig;
  },
  /**
   * Extra suspension gate the audio variant threads in (`audioSuspended`). Passed explicitly rather than probed off the
   * state map: every behavior receives the composition's full signal map at runtime, so an optional read here would
   * silently subscribe the video variant to the slot too.
   */
  audioSuspended?: ReadonlySignal<boolean | undefined>
): Reactor<FsmState | 'destroying' | 'destroyed'> {
  const { state, context, config } = deps;
  const createSubscriber = config?.createTrackSubscriber ?? createTrackSubscriberActor;
  const retryConfig = resolveRetryBackoffConfig(DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG, config?.subscribeRetry);
  // Indexing a mapped-type intersection by a generic key widens to the
  // union of every arm (same constraint documented in track-switching's
  // specialization helper) — go through wide records instead.
  const contextSlots = context as unknown as Record<
    SubscriberKey | PendingKey,
    Signal<TrackSubscriberActor | undefined>
  >;
  const stateSlots = state as unknown as Record<SelectionKey, ReadonlySignal<string | undefined>>;
  const subscriberSlot = contextSlots[wiring.subscriberKey];
  const pendingSlot = contextSlots[wiring.pendingKey];
  const selectionSignal = stateSlots[wiring.selectionKey];

  const derivedStateSignal = computed<FsmState>(() => {
    const actor = context.moqSessionActor.get();
    const sessionReady = !!actor && actor.snapshot.get().context.status === 'ready';
    // Same gate as HLS load-segments' full-range loading: default preload
    // ('metadata') must not download live media before load activation.
    const loadGateOpen = state.loadActivated.get() || state.preload.get() === 'auto';
    // Sustained pause (both variants) or autoplay-policy deferral (audio
    // only): release the subscription (the catalog stays subscribed);
    // reopening rejoins at the live edge via the initial filters.
    const suspended = state.mediaSuspended.get() === true || audioSuspended?.get() === true;

    return sessionReady && loadGateOpen && !suspended ? 'session-ready' : 'preconditions-unmet';
  });

  const clearSlots = (): void => {
    peek(pendingSlot)?.destroy();
    peek(subscriberSlot)?.destroy();
    pendingSlot.set(undefined);
    subscriberSlot.set(undefined);
  };

  // --- Dead-subscription recovery -------------------------------------
  // A subscription can die under a live selection: the publisher ended it
  // (PUBLISH_DONE on a broadcaster blip), the relay refused it, or the
  // stall watchdog gave up on it. The actors report that as a terminal
  // snapshot status; recovery destroys them and re-subscribes the same
  // selection at the live edge after a backoff.
  //
  // Status is read through `computed`s rather than tracked snapshot reads
  // so the effect re-fires on status *transitions* only — a raw tracked
  // read of the current subscriber's snapshot would re-run the effect on
  // every buffered frame for the whole life of the subscription.
  const isDead = (status: TrackSubscriberStatus | undefined): boolean => status === 'ended' || status === 'error';
  const currentStatusSignal = computed(() => subscriberSlot.get()?.snapshot.get().context.status);
  const pendingStatusSignal = computed(() => pendingSlot.get()?.snapshot.get().context.status);
  // Bumped by the rejoin timer: after the dead subscriber's slots are
  // cleared nothing else re-fires the effect (slot reads are peeked), so
  // the timer's bump is what re-runs it to build the fresh subscription.
  const rejoinTick = signal(0);
  // Closure-held on purpose (entry and effects need to share them);
  // `entry` resets them so no retry state leaks across state cycles.
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempts = 0;
  /**
   * The subscriber the last recovery created, until it proves healthy. The backoff may only reset on _that_ actor going
   * `'active'` — a healthy current is exactly what keeps playing while a handoff retry fails over and over, so any
   * reset keyed on the steady state (rather than on the replacement itself) re-runs every handoff retry at attempt 0
   * and never spends a finite budget.
   */
  let recoveryTarget: TrackSubscriberActor | undefined;

  /**
   * The selection an armed rejoin timer is recovering. A retry belongs to the track that died — a selection that
   * changes mid-backoff must not wait it out, and by then the slots are empty, so the timer itself has to carry the
   * identity the corpse no longer can.
   */
  let retryTrackId: string | undefined;

  const clearRetryTimer = (): void => {
    if (retryTimer === undefined) return;

    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryTrackId = undefined;
  };

  /**
   * The Retry Interval a REQUEST_ERROR death carried, when it did — an overloaded relay's stated pacing outranks the
   * local backoff, same as the catalog retry path.
   */
  const serverRetryIntervalMs = (actor: TrackSubscriberActor): number => {
    const error = peek(actor.snapshot).context.error as { retryInterval?: unknown } | undefined;

    return typeof error?.retryInterval === 'number' ? error.retryInterval : 0;
  };

  /**
   * Died in a way an identical replacement would repeat — spent auth refresh, permanent request rejection, auth-shaped
   * PUBLISH_DONE (see `TrackSubscriberContext.unrecoverable`). Recovery must not loop on it: with the default infinite
   * budget it would rebuild the same failure forever. The corpse stays in its slot (the spent-budget shape); a
   * selection change still moves past it.
   */
  const isUnrecoverable = (actor: TrackSubscriberActor): boolean => peek(actor.snapshot).context.unrecoverable === true;

  /**
   * Arm the rejoin backoff for `trackId`, honoring a server-stated Retry Interval above the local delay. Returns false
   * when the retry budget is spent.
   */
  const armRejoinTimer = (trackId: string, retryIntervalMs = 0): boolean => {
    const delay = retryDelayMs(retryAttempts, retryConfig);
    if (delay === undefined) return false;

    retryAttempts++;
    retryTrackId = trackId;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        retryTrackId = undefined;
        rejoinTick.set(peek(rejoinTick) + 1);
      },
      Math.max(delay, Math.min(retryIntervalMs, MAX_SERVER_RETRY_INTERVAL_MS))
    );
    return true;
  };

  return createMachineReactor<FsmState>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      'session-ready': {
        // Subscriptions live exactly as long as the session state — exit
        // (session loss, source change, destroy) cancels both actors.
        entry: () => {
          retryAttempts = 0;
          recoveryTarget = undefined;
          return () => {
            clearRetryTimer();
            clearSlots();
          };
        },
        effects: [
          () => {
            // Tracked: the rejoin timer bumps this once its backoff elapses.
            rejoinTick.get();
            const actor = context.moqSessionActor.get()!;
            const session = actor.snapshot.get().context.session;
            const selectedId = selectionSignal.get();
            const presentation = state.presentation.get();

            let current = peek(subscriberSlot);
            let pending = peek(pendingSlot);

            if (!selectedId || !session || !presentation) {
              if (current || pending) clearSlots();

              return;
            }

            const currentStatus = currentStatusSignal.get();
            const pendingStatus = pendingStatusSignal.get();

            // The outage is over only when the recovery's own replacement
            // reaches the relay (SUBSCRIBE_OK / a first frame) — see
            // `recoveryTarget`. It may sit in either slot: a live-edge
            // rejoin recreates the current, a handoff retry recreates the
            // pending (and promotion moves it across).
            if (recoveryTarget !== undefined) {
              const recoveredStatus =
                recoveryTarget === current ? currentStatus : recoveryTarget === pending ? pendingStatus : undefined;

              if (recoveredStatus === 'active') {
                recoveryTarget = undefined;
                retryAttempts = 0;
              } else if (recoveryTarget.track.id !== selectedId) {
                // The selection abandoned this recovery before its
                // replacement proved anything — the accumulated (possibly
                // spent) budget belongs to the abandoned track and must
                // not tax the new one.
                recoveryTarget = undefined;
                retryAttempts = 0;
              }
            }

            // A selection that moved past a dead actor makes its recovery
            // moot — and under a spent retry budget, waiting on it would
            // wedge every later selection. Drop the corpse and the retry
            // state, and let this same pass subscribe the new selection:
            // the effect does not re-fire on its own slot writes, so the
            // locals are cleared to match and control falls through to the
            // normal creation path below.
            if (current && isDead(currentStatus) && current.track.id !== selectedId) {
              clearRetryTimer();
              retryAttempts = 0;
              recoveryTarget = undefined;
              clearSlots();
              current = undefined;
              pending = undefined;
            } else if (pending && isDead(pendingStatus) && pending.track.id !== selectedId) {
              clearRetryTimer();
              retryAttempts = 0;
              recoveryTarget = undefined;
              pending.destroy();
              pendingSlot.set(undefined);
              pending = undefined;
            }

            if (current && isDead(currentStatus)) {
              // PUBLISH_DONE keeps delivering: the protocol layer holds the
              // alias route open after DONE precisely so late subgroups
              // still arrive, and the renderers keep draining the buffer.
              // Destroying now would cut the tail the viewer already
              // received — an ended broadcast's last seconds — so recovery
              // waits for the drain. (Tracked frameCount read: arrivals and
              // drains re-fire this effect only while an ended tail is
              // playing out.) 'error'/stall deaths have no tail worth
              // keeping and take the immediate path.
              if (currentStatus === 'ended' && current.snapshot.get().context.frameCount > 0) {
                return;
              }

              // NOTE(tail-completeness): frameCount === 0 approximates "the
              // tail played out" — subgroup streams still in flight after
              // PUBLISH_DONE and frames the renderers already own are not
              // counted, so up to a few hundred ms can still be cut. Exact
              // accounting needs the subscriber to reconcile subgroup FINs
              // against PublishDone.streamCount and the renderers to report
              // drained pipelines; not worth that machinery yet.
              if (isUnrecoverable(current)) return;

              // The subscription is dead and drained; whatever it buffered
              // has played. Drop it (and any in-flight handoff — promotion
              // gates on a playout clock this dead track would stall) and
              // rejoin the selection at the live edge once the backoff
              // elapses. No fresh subscriber is created before the timer
              // fires: the guard below holds creation while it runs.
              if (retryTimer === undefined && armRejoinTimer(selectedId, serverRetryIntervalMs(current))) {
                clearSlots();
              }

              return;
            }

            // A backoff armed for a selection that no longer stands is the
            // dead track's, not the new one's — cancel it with the rest of
            // the retry state and let this pass subscribe the new track.
            if (retryTimer !== undefined && retryTrackId !== selectedId) {
              clearRetryTimer();
              retryAttempts = 0;
              recoveryTarget = undefined;
            }

            // While a rejoin backoff runs, nothing may (re)subscribe — the
            // timer's tick re-runs this effect and the normal creation path
            // below performs the live-edge join.
            if (retryTimer !== undefined) return;

            if (current?.track.id === selectedId) {
              // Selection reverted while a handoff was in flight.
              if (pending) {
                pending.destroy();
                pendingSlot.set(undefined);
              }

              return;
            }

            if (pending && isDead(pendingStatus)) {
              // Unrecoverable death: a replacement dies identically, so
              // the corpse holds the slot (spent-budget shape) instead of
              // rebuilding the same failure forever.
              if (isUnrecoverable(pending)) return;

              // A handoff target died before promoting (e.g. the relay
              // refused the new track). Keep playing the current track,
              // drop the dead pending, and let the backoff pace the retry.
              // Arming cannot clobber a live timer — this branch sits below
              // the retryTimer bail above. When the budget is spent, the
              // dead pending stays in its slot on purpose: clearing it
              // would let the creation path below re-subscribe the same
              // dead track with no delay at all.
              if (!armRejoinTimer(selectedId, serverRetryIntervalMs(pending))) return;

              pending.destroy();
              pendingSlot.set(undefined);
              return;
            }

            if (pending?.track.id === selectedId) {
              // Handoff in flight: tracked read — the swap fires when the
              // new subscription has a decodable keyframe buffered.
              const pendingContext = pending.snapshot.get().context;
              if (!pendingContext.hasDecodableFrame) return;

              // The pending subscription joined at the live edge, but the
              // playout clock runs ~targetLatency behind it — promoting
              // before its frames are due freezes video / gaps audio for
              // that window. Wait until the oldest buffered frame is due
              // at the clock. Tracked currentTime read lives inside this
              // branch only, so the clock cadence re-fires the effect just
              // while a handoff is in flight. No clock (video-only) or no
              // timestamp yet → promote immediately (video self-clock
              // re-anchors).
              const currentTime = state.currentTime.get();
              const oldestTimestampUs = pendingContext.oldestTimestampUs;
              const due =
                currentTime === undefined ||
                oldestTimestampUs === undefined ||
                oldestTimestampUs <= currentTime * 1e6 + PROMOTION_EPSILON_US;

              if (due) {
                current?.destroy();
                subscriberSlot.set(pending);
                pendingSlot.set(undefined);
              }

              return;
            }

            const track = findTrack(presentation, wiring.trackType, selectedId);
            if (!track || !isLiveTrack(track) || !('moq' in track)) return;

            const subscriber = createSubscriber({
              session,
              track: track as MoqTrack,
              // Switch handoffs land on the next group boundary (an MSF
              // time-aligned random-access point); the initial join uses
              // the variant's configured filter.
              locationFilter: current ? { type: 'relative-group', groupsBeforeNext: 0 } : wiring.joinFilter,
              parameters: actor.getAuthParameters(),
              refreshAuth: () => actor.refreshAuthToken(),
              stallTimeoutMs: config?.subscribeStallTimeoutMs,
            });

            // Tracked read: subscribing this effect to the new actor's
            // snapshot is what re-fires the handoff check as frames land.
            subscriber.snapshot.get();

            // A creation while attempts are outstanding IS the recovery's
            // replacement — the one whose health resets the backoff.
            if (retryAttempts > 0) recoveryTarget = subscriber;

            if (!current) {
              subscriberSlot.set(subscriber);
            } else {
              pending?.destroy();
              pendingSlot.set(subscriber);
            }
          },
        ],
      },
    },
  });
}

// ============================================================================
// Variants
// ============================================================================

/**
 * Video: joins at the next group boundary so decode starts on a keyframe.
 *
 * @example
 *   const reactor = subscribeSelectedVideoTrack.setup({ state, context });
 */
export const subscribeSelectedVideoTrack = defineBehavior({
  stateKeys: ['presentation', 'selectedVideoTrackId', 'preload', 'loadActivated', 'mediaSuspended', 'currentTime'],
  contextKeys: ['moqSessionActor', 'videoSubscriberActor', 'pendingVideoSubscriberActor'],
  setup: (deps: {
    state: VariantStateMap<'selectedVideoTrackId'>;
    context: VariantContextMap<'videoSubscriberActor', 'pendingVideoSubscriberActor'>;
    config?: SubscribeSelectedTracksConfig;
  }) =>
    setupSubscribeSelectedTrack(
      {
        trackType: 'video',
        selectionKey: 'selectedVideoTrackId',
        subscriberKey: 'videoSubscriberActor',
        pendingKey: 'pendingVideoSubscriberActor',
        joinFilter: { type: 'relative-group', groupsBeforeNext: 0 },
      },
      deps
    ),
});

/**
 * Audio: every frame is independently decodable, so the initial join starts straight at the live edge. Also the only
 * reader of the `audioSuspended` autoplay-policy gate — deferred-audio playback keeps video subscribed while audio
 * waits for the user-gesture unlock.
 *
 * @example
 *   const reactor = subscribeSelectedAudioTrack.setup({ state, context });
 */
export const subscribeSelectedAudioTrack = defineBehavior({
  stateKeys: [
    'presentation',
    'selectedAudioTrackId',
    'preload',
    'loadActivated',
    'mediaSuspended',
    'audioSuspended',
    'currentTime',
  ],
  contextKeys: ['moqSessionActor', 'audioSubscriberActor', 'pendingAudioSubscriberActor'],
  setup: (deps: {
    state: VariantStateMap<'selectedAudioTrackId'> & {
      audioSuspended: ReadonlySignal<SubscribeSelectedTracksState['audioSuspended']>;
    };
    context: VariantContextMap<'audioSubscriberActor', 'pendingAudioSubscriberActor'>;
    config?: SubscribeSelectedTracksConfig;
  }) =>
    // Explicit type arguments: the `audioSuspended` intersection on `state`
    // defeats inference of the selection key from the mapped type, which
    // would otherwise widen to the full `SelectionKey` union.
    setupSubscribeSelectedTrack<'selectedAudioTrackId', 'audioSubscriberActor', 'pendingAudioSubscriberActor'>(
      {
        trackType: 'audio',
        selectionKey: 'selectedAudioTrackId',
        subscriberKey: 'audioSubscriberActor',
        pendingKey: 'pendingAudioSubscriberActor',
        joinFilter: { type: 'next-object' },
      },
      deps,
      deps.state.audioSuspended
    ),
});
