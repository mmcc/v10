import { describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { MoqVideoTrack } from '../../../media/moq/parse-catalog';
import type { MaybeResolvedPresentation } from '../../../media/types';
import type { MoqtSession } from '../../../network/moqt/session';
import type { MoqSessionActor, MoqSessionActorContext } from '../../actors/moq-session';
import type {
  CreateTrackSubscriberOptions,
  TrackSubscriberActor,
  TrackSubscriberContext,
} from '../../actors/track-subscriber';
import { subscribeSelectedVideoTrack } from '../subscribe-selected-tracks';

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

const HD = moqVideoTrack('hd', 5_000_000);
const SD = moqVideoTrack('sd', 1_000_000);

const PRESENTATION: MaybeResolvedPresentation = {
  id: 'moq:test',
  url: 'moqt://relay/live#msf:live--catalog',
  selectionSets: [{ id: 'v', type: 'video', switchingSets: [{ id: 'v-main', type: 'video', tracks: [HD, SD] }] }],
};

// ============================================================================
// Fakes
// ============================================================================

interface FakeSubscriber extends TrackSubscriberActor {
  options: CreateTrackSubscriberOptions;
  destroyed: boolean;
  /** Simulate a buffered keyframe-led group. */
  becomeDecodable(): void;
}

function createFakeSubscriberFactory() {
  const created: FakeSubscriber[] = [];
  const factory = ((options: CreateTrackSubscriberOptions) => {
    const snapshot = signal({
      value: 'active' as const,
      context: { status: 'active', hasDecodableFrame: false, frameCount: 0 } as TrackSubscriberContext,
    });
    const subscriber: FakeSubscriber = {
      options,
      destroyed: false,
      track: options.track,
      snapshot: snapshot as TrackSubscriberActor['snapshot'],
      peek: () => undefined,
      dequeue: () => undefined,
      skipToLatestGroup: () => 0,
      becomeDecodable() {
        snapshot.set({ value: 'active', context: { ...snapshot.get().context, hasDecodableFrame: true } });
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

function makeDeps() {
  const session = { ready: Promise.resolve() } as unknown as MoqtSession;
  const sessionSnapshot = signal({
    value: 'active' as const,
    context: { status: 'ready', session } as MoqSessionActorContext,
  });
  const sessionActor: MoqSessionActor = {
    snapshot: sessionSnapshot as MoqSessionActor['snapshot'],
    getAuthParameters: () => ({}),
    refreshAuthToken: async () => ({}),
    destroy: () => {},
  };
  return {
    state: {
      presentation: signal<MaybeResolvedPresentation | undefined>(PRESENTATION),
      selectedVideoTrackId: signal<string | undefined>(undefined),
    },
    context: {
      moqSessionActor: signal<MoqSessionActor | undefined>(sessionActor),
      videoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
      pendingVideoSubscriberActor: signal<TrackSubscriberActor | undefined>(undefined),
    },
  };
}

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
});
