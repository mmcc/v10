/**
 * **Turn per-type track selection into MoQ subscriptions.** The MoQ analog
 * of `resolve-track` + `load-segments` combined: reacts to
 * `selected{Video,Audio}TrackId` (written by the reused `track-switching`
 * behaviors) and keeps exactly one live `track-subscriber` actor per type
 * in context, feeding the renderers.
 *
 * Switches are **make-before-break**: the new track is subscribed at an
 * MSF time-aligned boundary (`next-group-start` — groups open with a
 * random-access point, and alternate-group tracks share group numbers,
 * §4.2) while the old subscription keeps playing. Only once the new
 * subscriber has buffered a decodable keyframe-led group
 * (`hasDecodableFrame`) *and* its oldest frame is due at the playout
 * clock (`currentTime`) does the swap happen: old cancelled, new
 * promoted.
 * That's what prevents playback gaps on ABR/language switches, and it's
 * why each type has a `pending*SubscriberActor` sibling slot — old and
 * new overlap during the handoff.
 *
 * ```
 * 'preconditions-unmet' → 'session-ready'
 * ```
 *
 * `'session-ready'` requires the session actor to be ready, the load
 * gate to be open (`loadActivated || preload === 'auto'` — the same gate
 * as HLS `load-segments`' full-range loading), *and* media delivery not
 * suspended (`mediaSuspended`, set by `suspend-media-while-paused` when a
 * pause outlives its hold window). Catalog resolution stays ungated in
 * `resolve-catalog`, so `preload: 'metadata'` still resolves tracks
 * without downloading media — and a suspended pause keeps receiving
 * catalog updates. Closing either gate exits the state and tears both
 * subscribers down; reopening re-subscribes the current selection through
 * the initial-join filters (a live-edge rejoin, not a handoff).
 *
 * Sole writer of its type's `*SubscriberActor` + `pending*SubscriberActor`
 * slots (renderers and latency/bandwidth behaviors only read). Slot reads
 * inside the effect use `peek` — the effect re-fires on selection/session/
 * pending-snapshot changes, not on its own slot writes.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import type { MoqTrack } from '../../media/moq/parse-catalog';
import { isLiveTrack, type MaybeResolvedPresentation } from '../../media/types';
import { findTrack } from '../../media/utils/tracks';
import type { LocationFilter } from '../../network/moqt/control-messages';
import type { MoqSessionActor } from '../actors/moq-session';
import { createTrackSubscriberActor, type TrackSubscriberActor } from '../actors/track-subscriber';

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
}

type SelectionKey = 'selectedVideoTrackId' | 'selectedAudioTrackId';
type SubscriberKey = 'videoSubscriberActor' | 'audioSubscriberActor';
type PendingKey = 'pendingVideoSubscriberActor' | 'pendingAudioSubscriberActor';

type FsmState = 'preconditions-unmet' | 'session-ready';

/**
 * Promotion slack: one ~30fps frame in microseconds. The pending
 * subscriber's oldest frame counts as "due" this close to the playout
 * clock so promotion doesn't wait a full clock tick past the boundary.
 */
const PROMOTION_EPSILON_US = 33_000;

interface VariantWiring {
  trackType: 'video' | 'audio';
  selectionKey: SelectionKey;
  subscriberKey: SubscriberKey;
  pendingKey: PendingKey;
  /** Filter for the *initial* subscription of this type (no handoff). */
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
  }
): Reactor<FsmState | 'destroying' | 'destroyed'> {
  const { state, context, config } = deps;
  const createSubscriber = config?.createTrackSubscriber ?? createTrackSubscriberActor;
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
    // Sustained pause: release the media subscriptions (the catalog stays
    // subscribed); resume rejoins at the live edge via the initial filters.
    const suspended = state.mediaSuspended.get() === true;
    return sessionReady && loadGateOpen && !suspended ? 'session-ready' : 'preconditions-unmet';
  });

  const clearSlots = (): void => {
    peek(pendingSlot)?.destroy();
    peek(subscriberSlot)?.destroy();
    pendingSlot.set(undefined);
    subscriberSlot.set(undefined);
  };

  return createMachineReactor<FsmState>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      'session-ready': {
        // Subscriptions live exactly as long as the session state — exit
        // (session loss, source change, destroy) cancels both actors.
        entry: () => clearSlots,
        effects: [
          () => {
            const actor = context.moqSessionActor.get()!;
            const session = actor.snapshot.get().context.session;
            const selectedId = selectionSignal.get();
            const presentation = state.presentation.get();

            const current = peek(subscriberSlot);
            const pending = peek(pendingSlot);

            if (!selectedId || !session || !presentation) {
              if (current || pending) clearSlots();
              return;
            }

            if (current?.track.id === selectedId) {
              // Selection reverted while a handoff was in flight.
              if (pending) {
                pending.destroy();
                pendingSlot.set(undefined);
              }
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
              locationFilter: current ? { type: 'next-group-start' } : wiring.joinFilter,
              parameters: actor.getAuthParameters(),
              refreshAuth: () => actor.refreshAuthToken(),
            });
            // Tracked read: subscribing this effect to the new actor's
            // snapshot is what re-fires the handoff check as frames land.
            subscriber.snapshot.get();

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
 * const reactor = subscribeSelectedVideoTrack.setup({ state, context });
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
        joinFilter: { type: 'next-group-start' },
      },
      deps
    ),
});

/**
 * Audio: every frame is independently decodable, so the initial join
 * starts straight at the live edge.
 *
 * @example
 * const reactor = subscribeSelectedAudioTrack.setup({ state, context });
 */
export const subscribeSelectedAudioTrack = defineBehavior({
  stateKeys: ['presentation', 'selectedAudioTrackId', 'preload', 'loadActivated', 'mediaSuspended', 'currentTime'],
  contextKeys: ['moqSessionActor', 'audioSubscriberActor', 'pendingAudioSubscriberActor'],
  setup: (deps: {
    state: VariantStateMap<'selectedAudioTrackId'>;
    context: VariantContextMap<'audioSubscriberActor', 'pendingAudioSubscriberActor'>;
    config?: SubscribeSelectedTracksConfig;
  }) =>
    setupSubscribeSelectedTrack(
      {
        trackType: 'audio',
        selectionKey: 'selectedAudioTrackId',
        subscriberKey: 'audioSubscriberActor',
        pendingKey: 'pendingAudioSubscriberActor',
        joinFilter: { type: 'largest-object' },
      },
      deps
    ),
});
