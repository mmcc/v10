import { describe, expect, it, vi } from 'vite-plus/test';

import { createSubgroupWriter } from '../../network/moqt/subgroup-writer';
import { createMoqtPublishSession } from '../session/publish-session';
import { createRelayHub } from './helpers/relay-hub';

/**
 * The relay hub against the real publish-session driver — the hub's own announce-and-serve contract, at the seams the
 * cross-engine suites are too coarse to pin down.
 */
describe('createRelayHub', () => {
  it.each([false, true])('follows live after a relay 0.14.17 pull (existing content: %s)', async (hasContent) => {
    const hub = createRelayHub();
    const { transport } = hub.connectPublisher({ url: 'https://relay.test/moq', namespace: ['live'] });
    const onSubscribe = vi.fn();
    const onTrackBinding = vi.fn();
    const onClosed = vi.fn();
    const session = createMoqtPublishSession(transport, { callbacks: { onSubscribe, onTrackBinding, onClosed } });

    try {
      await session.ready;
      session.announce(['live']);
      session.registerTrack({
        trackNamespace: ['live'],
        trackName: 'video',
        getLargestObject: () => (hasContent ? { group: 255, object: 128 } : undefined),
      });
      hub.subscribeUpstream('video');
      await vi.waitFor(() => {
        expect(onSubscribe).toHaveBeenCalledWith(
          expect.objectContaining({
            parameters: expect.objectContaining({
              subscriberPriority: 255,
              locationFilter: { type: 'next-object' },
              fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 1 } },
            }),
          })
        );
        expect(onTrackBinding).toHaveBeenCalledWith({ trackName: 'video', trackAlias: expect.any(Number) });
        expect(hub.fills).toEqual(hasContent ? [{ requestId: 3, reset: true }] : []);
      });

      const trackAlias = onTrackBinding.mock.calls[0]![0].trackAlias;
      const stream = createSubgroupWriter(await session.openUniStream(), {
        trackAlias,
        groupId: 256,
        endOfGroup: true,
      });

      await stream.writeObject({ objectId: 0, payload: Uint8Array.of(1, 2, 3) });
      await stream.fin();
      await vi.waitFor(() => expect(hub.objectCount('video')).toBe(1));
      expect(hub.fills).toEqual(hasContent ? [{ requestId: 3, reset: true }] : []);
      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      session.destroy();
      hub.destroy();
    }
  });

  it('re-pulls a track the publisher ended and re-registered while demand stands', async () => {
    const hub = createRelayHub();
    const { transport } = hub.connectPublisher({ url: 'https://relay.test/moq', namespace: ['live'] });
    const served: string[] = [];
    const session = createMoqtPublishSession(transport, {
      callbacks: { onSubscribe: (subscribe) => served.push(subscribe.trackName) },
    });

    await session.ready;
    session.announce(['live']);

    // Standing demand pulls the registered track once the announce lands.
    const first = session.registerTrack({ trackNamespace: ['live'], trackName: 'video' });

    hub.subscribeUpstream('video');
    await vi.waitFor(() => {
      expect(hub.subscribes).toEqual(['video']);
      expect(served).toEqual(['video']);
    });

    // The publisher ends the track: a bare FIN on the hub's SUBSCRIBE
    // stream, recorded as the churn signal.
    first.end();
    await vi.waitFor(() => {
      expect(hub.trackEnds).toEqual([{ kind: 'subscribe-fin', trackName: 'video' }]);
    });

    // The same name comes back in the same session — the churn shape the
    // hub exists to observe. Standing demand must get a fresh upstream
    // SUBSCRIBE rather than short-circuit on the dead subscription's
    // dedupe slot.
    session.registerTrack({ trackNamespace: ['live'], trackName: 'video' });
    hub.subscribeUpstream('video');
    await vi.waitFor(() => {
      expect(hub.subscribes).toEqual(['video', 'video']);
      expect(served).toEqual(['video', 'video']);
    });

    session.destroy();
    hub.destroy();
  });
});
