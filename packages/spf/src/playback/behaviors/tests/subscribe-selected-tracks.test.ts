import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { MoqAudioTrack, MoqVideoTrack } from '../../../media/moq/parse-catalog';
import type { MaybeResolvedPresentation } from '../../../media/types';
import type { MoqtSession } from '../../../network/moqt/session';
import type { MoqSessionActor, MoqSessionActorContext } from '../../actors/moq-session';
import type {
  CreateTrackSubscriberOptions,
  TrackSubscriberActor,
  TrackSubscriberContext,
} from '../../actors/track-subscriber';
import { subscribeSelectedAudioTrack, subscribeSelectedVideoTrack } from '../subscribe-selected-tracks';

// ============================================================================
// Fixtures
// ============================================================================

function moqVideoTrack(name: string, bandwidth: number): MoqVideoTrack {
  return {
    type: 'video',
    id: `live/${name}`,
    url: `moqt://relay/live#msf:live--${name}`,
    mimeType: 'video/loc',
    bandwidth,
    codecs: ['avc1.64001f'],
    deliveryMode: 'push',
    moq: { namespace: ['live'], name, packaging: 'loc', isLive: true },
  };
}

function moqAudioTrack(name: string, bandwidth: number): MoqAudioTrack {
  return {
    type: 'audio',
    id: `live/${name}`,
    url: `moqt://relay/live#msf:live--${name}`,
    mimeType: 'audio/loc',
    bandwidth,
    codecs: ['mp4a.40.2'],
    groupId: 'audio',
    name,
    sampleRate: 48_000,
    channels: 2,
    deliveryMode: 'push',
    moq: { namespace: ['live'], name, packaging: 'loc', isLive: true },
  };
}

const HD = moqVideoTrack('hd', 5_000_000);
const SD = moqVideoTrack('sd', 1_000_000);
const LD = moqVideoTrack('ld', 300_000);
const MAIN_AUDIO = moqAudioTrack('main', 128_000);

const PRESENTATION: MaybeResolvedPresentation = {
  id: 'moq:test',
  url: 'moqt://relay/live#msf:live--catalog',
  selectionSets: [
    { id: 'v', type: 'video', switchingSets: [{ id: 'v-main', type: 'video', tracks: [HD, SD, LD] }] },
    { id: 'a', type: 'audio', switchingSets: [{ id: 'a-main', type: 'audio', tracks: [MAIN_AUDIO] }] },
  ],
};

// ============================================================================
// Fakes
// ============================================================================

interface FakeSubscriber extends TrackSubscriberActor {
  options: CreateTrackSubscriberOptions;
  destroyed: boolean;
  /** Simulate a buffered keyframe-led group (optionally at a timestamp). */
  becomeDecodable(oldestTimestampUs?: number): void;
  /** Simulate SUBSCRIBE_OK — the subscription reached the relay. */
  activate(): void;
  /**
   * Simulate the subscription dying: the publisher ended it (`'ended'`) or
   * the request failed / the stall watchdog gave up (`'error'`).
   */
  die(status: 'ended' | 'error'): void;
}

function createFakeSubscriberFactory({
  initialStatus = 'active',
}: {
  initialStatus?: TrackSubscriberContext['status'];
} = {}) {
  const created: FakeSubscriber[] = [];
  const factory = ((options: CreateTrackSubscriberOptions) => {
    const snapshot = signal({
      value: 'active' as const,
      context: { status: initialStatus, hasDecodableFrame: false, frameCount: 0 } as TrackSubscriberContext,
    });
    const subscriber: FakeSubscriber = {
      options,
      destroyed: false,
      track: options.track,
      snapshot: snapshot as TrackSubscriberActor['snapshot'],
      peek: () => undefined,
      dequeue: () => undefined,
      skipToLatestGroup: () => 0,
      becomeDecodable(oldestTimestampUs?: number) {
        snapshot.set({
          value: 'active',
          context: { ...snapshot.get().context, hasDecodableFrame: true, oldestTimestampUs },
        });
      },
      activate() {
        snapshot.set({ value: 'active', context: { ...snapshot.get().context, status: 'active' } });
      },
      die(status: 'ended' | 'error') {
        snapshot.set({ value: 'active', context: { ...snapshot.get().context, status } });
      },
      destroy() {
        subscriber.destroyed = true;
      },
    };
    created.push(subscriber);
    return subscriber;
  }) as unknown as typeof import('../../actors/track-subscriber').createTrackSubscriberActor;
  return { factory, created: created as FakeSubscriber[] };
}

function makeSessionActor(): MoqSessionActor {
  const session = { ready: Promise.resolve() } as unknown as MoqtSession;
  const sessionSnapshot = signal({
    value: 'active' as const,
    context: { status: 'ready', session } as MoqSessionActorContext,
  });
  return {
    snapshot: sessionSnapshot as MoqSessionActor['snapshot'],
    getAuthParameters: () => ({}),
    refreshAuthToken: async () => ({}),
    destroy: () => {},
  };
}

function makeDeps() {
  return {
    state: {
      presentation: signal<MaybeResolvedPresentation | undefined>(PRESENTATION),
      selectedVideoTrackId: signal<string | undefined>(undefined),
      preload: signal<'auto' | 'metadata' | 'none' | undefined>(undefined),
      loadActivated: signal<boolean | undefined>(true),
      mediaSuspended: signal<boolean | undefined>(undefined),
      currentTime: signal<number | undefined>(undefined),
    },
    context: {
      moqSessionActor: signal<MoqSessionActor | undefined>(makeSessionActor()),
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      pendingVideoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
    },
  };
}

function makeAudioDeps() {
  return {
    state: {
      presentation: signal<MaybeResolvedPresentation | undefined>(PRESENTATION),
      selectedAudioTrackId: signal<string | undefined>(undefined),
      preload: signal<'auto' | 'metadata' | 'none' | undefined>(undefined),
      loadActivated: signal<boolean | undefined>(true),
      mediaSuspended: signal<boolean | undefined>(undefined),
      audioSuspended: signal<boolean | undefined>(undefined),
      currentTime: signal<number | undefined>(undefined),
    },
    context: {
      moqSessionActor: signal<MoqSessionActor | undefined>(makeSessionActor()),
      audioSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      pendingAudioSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
    },
  };
}

// Dead-subscription rejoin backoff (`DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG`):
// a 500ms initial delay jittered ±25%, i.e. 375–625ms for the first retry.
// Recovery tests either stop short of the floor (nothing may re-subscribe
// yet) or advance generously past the ceiling.
const BELOW_REJOIN_BACKOFF_MS = 300;
const PAST_REJOIN_BACKOFF_MS = 1_000;

// ============================================================================
// Tests
// ============================================================================

describe('subscribeSelectedVideoTrack', () => {
  it('subscribes the selected track at the next group boundary', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.options).toMatchObject({
      track: { id: HD.id },
      locationFilter: { type: 'next-group-start' },
    });
    expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

    reactor.destroy();
    expect(created[0]!.destroyed).toBe(true);
    expect(deps.context.videoSubscriberActor.get()).toBeUndefined();
  });

  it('hands off make-before-break on a track switch', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    // ABR picks SD: the new subscription overlaps the old.
    deps.state.selectedVideoTrackId.set(SD.id);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);
    expect(deps.context.pendingVideoSubscriberActor.get()).toBe(created[1]);
    expect(created[0]!.destroyed).toBe(false); // old keeps playing

    // The swap happens only once the new track has a decodable keyframe.
    created[1]!.becomeDecodable();
    await vi.waitFor(() => expect(deps.context.videoSubscriberActor.get()).toBe(created[1]));
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();
    expect(created[0]!.destroyed).toBe(true);

    reactor.destroy();
  });

  it('waits for the playout clock to reach the pending track before completing the swap', async () => {
    const deps = makeDeps();
    deps.state.currentTime.set(10);
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    deps.state.selectedVideoTrackId.set(SD.id);
    await vi.waitFor(() => expect(created).toHaveLength(2));

    // Decodable, but joined at the live edge — its frames aren't due at
    // the playout clock yet, so the old subscription keeps playing.
    created[1]!.becomeDecodable(10_600_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);
    expect(deps.context.pendingVideoSubscriberActor.get()).toBe(created[1]);
    expect(created[0]!.destroyed).toBe(false);

    // The clock catches up to the pending track's oldest frame → swap.
    deps.state.currentTime.set(10.6);
    await vi.waitFor(() => expect(deps.context.videoSubscriberActor.get()).toBe(created[1]));
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();
    expect(created[0]!.destroyed).toBe(true);

    reactor.destroy();
  });

  it('does not subscribe under default preload until load activation', async () => {
    const deps = makeDeps();
    deps.state.loadActivated.set(false);
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    // Default preload ('metadata') must not start live media downloads.
    deps.state.selectedVideoTrackId.set(HD.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(0);

    deps.state.loadActivated.set(true);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);

    reactor.destroy();
  });

  it('subscribes without load activation when preload is auto', async () => {
    const deps = makeDeps();
    deps.state.loadActivated.set(false);
    deps.state.preload.set('auto');
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    reactor.destroy();
  });

  it('tears down subscribers when the gate closes', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    deps.state.loadActivated.set(false);
    await vi.waitFor(() => expect(created[0]!.destroyed).toBe(true));
    expect(deps.context.videoSubscriberActor.get()).toBeUndefined();
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

    reactor.destroy();
  });

  it('releases subscribers while media is suspended and rejoins at the live edge on resume', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    // Sustained pause: the media subscription releases; the session (and
    // with it the catalog subscription) is untouched by this behavior.
    deps.state.mediaSuspended.set(true);
    await vi.waitFor(() => expect(created[0]!.destroyed).toBe(true));
    expect(deps.context.videoSubscriberActor.get()).toBeUndefined();
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

    // Resume: a fresh initial join (next-group-start), not a handoff.
    deps.state.mediaSuspended.set(undefined);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[1]!.options).toMatchObject({
      track: { id: HD.id },
      locationFilter: { type: 'next-group-start' },
    });
    expect(deps.context.videoSubscriberActor.get()).toBe(created[1]);
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

    reactor.destroy();
  });

  it('releases a suspended in-flight handoff without leaking the pending subscriber', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    deps.state.selectedVideoTrackId.set(SD.id);
    await vi.waitFor(() => expect(created).toHaveLength(2));

    deps.state.mediaSuspended.set(true);
    await vi.waitFor(() => expect(created[0]!.destroyed).toBe(true));
    expect(created[1]!.destroyed).toBe(true);
    expect(deps.context.videoSubscriberActor.get()).toBeUndefined();
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

    reactor.destroy();
  });

  it('cancels the pending subscription when selection reverts mid-handoff', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    deps.state.selectedVideoTrackId.set(SD.id);
    await vi.waitFor(() => expect(created).toHaveLength(2));

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created[1]!.destroyed).toBe(true));
    expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);
    expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();
    expect(created[0]!.destroyed).toBe(false);

    reactor.destroy();
  });

  it('clears subscriptions when the selection clears', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    deps.state.selectedVideoTrackId.set(undefined);
    await vi.waitFor(() => expect(created[0]!.destroyed).toBe(true));
    expect(deps.context.videoSubscriberActor.get()).toBeUndefined();

    reactor.destroy();
  });

  it('ignores selections that are not live MoQ tracks', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedVideoTrackId.set('not-a-track');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(0);

    reactor.destroy();
  });

  // The autoplay-policy gate is threaded to the audio variant explicitly;
  // deferred-audio autoplay relies on video staying subscribed while set.
  it('is not gated by audioSuspended', async () => {
    const deps = makeDeps();
    // Every behavior receives the composition's full signal map at runtime,
    // so the slot is present — the video variant must simply never read it.
    const state = { ...deps.state, audioSuspended: signal<boolean | undefined>(true) };
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({
      ...deps,
      state,
      config: { createTrackSubscriber: factory },
    });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.destroyed).toBe(false);

    reactor.destroy();
  });

  it('threads the configured stall timeout into every subscriber it creates', async () => {
    const deps = makeDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedVideoTrack.setup({
      ...deps,
      config: { createTrackSubscriber: factory, subscribeStallTimeoutMs: 1234 },
    });

    deps.state.selectedVideoTrackId.set(HD.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    // The handoff target arms the same watchdog as the initial join.
    deps.state.selectedVideoTrackId.set(SD.id);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    for (const subscriber of created) expect(subscriber.options.stallTimeoutMs).toBe(1234);

    reactor.destroy();
  });

  describe('dead-subscription recovery', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejoins at the live edge after the current subscription errors', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      // Relay error / stall watchdog: the dead actor's buffer tail is all it
      // will ever deliver, so it is dropped immediately.
      created[0]!.die('error');
      await vi.advanceTimersByTimeAsync(0);
      expect(created[0]!.destroyed).toBe(true);
      expect(deps.context.videoSubscriberActor.get()).toBeUndefined();

      // Nothing re-subscribes while the rejoin backoff runs.
      await vi.advanceTimersByTimeAsync(BELOW_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(1);

      // The backoff elapsed: the same selection rejoins through the initial
      // join filter (a live-edge rejoin, not a handoff).
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(2);
      expect(created[1]!.options).toMatchObject({
        track: { id: HD.id },
        locationFilter: { type: 'next-group-start' },
      });
      expect(deps.context.videoSubscriberActor.get()).toBe(created[1]);
      expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();

      reactor.destroy();
    });

    it('rejoins at the live edge after the publisher ends the current subscription', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      // PUBLISH_DONE on a broadcaster blip, with the selection still standing.
      created[0]!.die('ended');
      await vi.advanceTimersByTimeAsync(0);
      expect(created[0]!.destroyed).toBe(true);
      expect(deps.context.videoSubscriberActor.get()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(BELOW_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(2);
      expect(created[1]!.options).toMatchObject({
        track: { id: HD.id },
        locationFilter: { type: 'next-group-start' },
      });
      expect(deps.context.videoSubscriberActor.get()).toBe(created[1]);

      reactor.destroy();
    });

    it('keeps the current subscription playing when a handoff target dies, then retries the switch', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      deps.state.selectedVideoTrackId.set(SD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(2);

      // The relay refused the new track before it could promote: only the
      // pending subscriber dies, the current one keeps playing.
      created[1]!.die('error');
      await vi.advanceTimersByTimeAsync(0);
      expect(created[1]!.destroyed).toBe(true);
      expect(deps.context.pendingVideoSubscriberActor.get()).toBeUndefined();
      expect(created[0]!.destroyed).toBe(false);
      expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);

      await vi.advanceTimersByTimeAsync(BELOW_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(2);

      // Same backoff paces the retry; a current subscription still exists,
      // so the new attempt is another group-boundary handoff.
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(3);
      expect(created[2]!.options).toMatchObject({
        track: { id: SD.id },
        locationFilter: { type: 'next-group-start' },
      });
      expect(deps.context.pendingVideoSubscriberActor.get()).toBe(created[2]);
      expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);

      reactor.destroy();
    });

    it('escalates the handoff retry backoff until the replacement proves healthy', async () => {
      const deps = makeDeps();
      // Real subscribers start 'pending' and only turn 'active' on
      // SUBSCRIBE_OK — a relay that keeps refusing the switch target never
      // activates it, which is what lets the backoff escalate.
      const { factory, created } = createFakeSubscriberFactory({ initialStatus: 'pending' });
      const reactor = subscribeSelectedVideoTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      deps.state.selectedVideoTrackId.set(SD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(2);

      // First failure retries within the initial-delay window (375–625ms).
      created[1]!.die('error');
      await vi.advanceTimersByTimeAsync(700);
      expect(created).toHaveLength(3);

      // The replacement never reached the relay, so the second failure's
      // delay doubles (750–1250ms): the 700ms that satisfied attempt 0
      // must not be enough for attempt 1.
      created[2]!.die('error');
      await vi.advanceTimersByTimeAsync(700);
      expect(created).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(600);
      expect(created).toHaveLength(4);

      // A replacement that reaches the relay resets the backoff: the next
      // failure retries within the initial-delay window again.
      created[3]!.activate();
      await vi.advanceTimersByTimeAsync(0);
      created[3]!.die('error');
      await vi.advanceTimersByTimeAsync(700);
      expect(created).toHaveLength(5);

      reactor.destroy();
    });

    it('leaves the dead subscription in place when recovery is disabled', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({
        ...deps,
        config: { createTrackSubscriber: factory, subscribeRetry: { maxAttempts: 0 } },
      });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      created[0]!.die('error');
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      // No retry budget: the dead actor stays in its slot untouched and the
      // engine's failover path owns the outcome.
      expect(created).toHaveLength(1);
      expect(created[0]!.destroyed).toBe(false);
      expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);

      reactor.destroy();
    });

    it('a new selection overrides a dead subscription whose retry budget is spent', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({
        ...deps,
        config: { createTrackSubscriber: factory, subscribeRetry: { maxAttempts: 0 } },
      });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      created[0]!.die('error');
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(1);

      // The budget only pins recovery of the *same* track — a different
      // selection must not stay wedged behind the corpse.
      deps.state.selectedVideoTrackId.set(SD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created[0]!.destroyed).toBe(true);
      expect(created).toHaveLength(2);
      expect(created[1]!.options).toMatchObject({
        track: { id: SD.id },
        locationFilter: { type: 'next-group-start' },
      });
      expect(deps.context.videoSubscriberActor.get()).toBe(created[1]);

      reactor.destroy();
    });

    it('a new selection replaces a dead handoff target whose retry budget is spent', async () => {
      const deps = makeDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedVideoTrack.setup({
        ...deps,
        config: { createTrackSubscriber: factory, subscribeRetry: { maxAttempts: 0 } },
      });

      deps.state.selectedVideoTrackId.set(HD.id);
      await vi.advanceTimersByTimeAsync(0);
      deps.state.selectedVideoTrackId.set(SD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(2);

      created[1]!.die('error');
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      // Budget spent: the dead handoff target holds the pending slot.
      expect(created).toHaveLength(2);
      expect(deps.context.pendingVideoSubscriberActor.get()).toBe(created[1]);

      deps.state.selectedVideoTrackId.set(LD.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created[1]!.destroyed).toBe(true);
      expect(created).toHaveLength(3);
      expect(created[2]!.options).toMatchObject({
        track: { id: LD.id },
        locationFilter: { type: 'next-group-start' },
      });
      expect(deps.context.pendingVideoSubscriberActor.get()).toBe(created[2]);
      expect(deps.context.videoSubscriberActor.get()).toBe(created[0]);

      reactor.destroy();
    });
  });
});

describe('subscribeSelectedAudioTrack', () => {
  it('releases the subscription while audio is suspended and rejoins at the live edge on unlock', async () => {
    const deps = makeAudioDeps();
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedAudioTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedAudioTrackId.set(MAIN_AUDIO.id);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.options).toMatchObject({
      track: { id: MAIN_AUDIO.id },
      locationFilter: { type: 'largest-object' },
    });

    // Autoplay started without a gesture: the adapter defers audio.
    deps.state.audioSuspended.set(true);
    await vi.waitFor(() => expect(created[0]!.destroyed).toBe(true));
    expect(deps.context.audioSubscriberActor.get()).toBeUndefined();
    expect(deps.context.pendingAudioSubscriberActor.get()).toBeUndefined();

    // First user gesture resumed the context: a fresh live-edge join.
    deps.state.audioSuspended.set(undefined);
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created[1]!.options).toMatchObject({
      track: { id: MAIN_AUDIO.id },
      locationFilter: { type: 'largest-object' },
    });
    expect(deps.context.audioSubscriberActor.get()).toBe(created[1]);

    reactor.destroy();
  });

  it('does not subscribe while audio starts out suspended', async () => {
    const deps = makeAudioDeps();
    deps.state.audioSuspended.set(true);
    const { factory, created } = createFakeSubscriberFactory();
    const reactor = subscribeSelectedAudioTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

    deps.state.selectedAudioTrackId.set(MAIN_AUDIO.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(0);

    deps.state.audioSuspended.set(undefined);
    await vi.waitFor(() => expect(created).toHaveLength(1));

    reactor.destroy();
  });

  describe('dead-subscription recovery', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejoins straight at the live edge after the subscription dies', async () => {
      const deps = makeAudioDeps();
      const { factory, created } = createFakeSubscriberFactory();
      const reactor = subscribeSelectedAudioTrack.setup({ ...deps, config: { createTrackSubscriber: factory } });

      deps.state.selectedAudioTrackId.set(MAIN_AUDIO.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(created).toHaveLength(1);

      created[0]!.die('ended');
      await vi.advanceTimersByTimeAsync(0);
      expect(created[0]!.destroyed).toBe(true);
      expect(deps.context.audioSubscriberActor.get()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(BELOW_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(1);

      // Audio's initial join filter — every frame is independently decodable.
      await vi.advanceTimersByTimeAsync(PAST_REJOIN_BACKOFF_MS);
      expect(created).toHaveLength(2);
      expect(created[1]!.options).toMatchObject({
        track: { id: MAIN_AUDIO.id },
        locationFilter: { type: 'largest-object' },
      });
      expect(deps.context.audioSubscriberActor.get()).toBe(created[1]);
      expect(deps.context.pendingAudioSubscriberActor.get()).toBeUndefined();

      reactor.destroy();
    });
  });
});
