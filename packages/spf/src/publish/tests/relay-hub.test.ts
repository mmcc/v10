import { describe, expect, it, vi } from 'vitest';
import { createMoqtPublishSession } from '../session/publish-session';
import { createRelayHub } from './helpers/relay-hub';

/**
 * The relay hub against the real publish-session driver — the hub's own
 * announce-and-serve contract, at the seams the cross-engine suites are
 * too coarse to pin down.
 */
describe('createRelayHub', () => {
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
