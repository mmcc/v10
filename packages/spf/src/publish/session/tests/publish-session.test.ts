import { describe, expect, it, vi } from 'vite-plus/test';

import { toLocFrame } from '../../../media/moq/loc';
import { packageLocFrame } from '../../../media/moq/loc-packaging';
import { applyMoqCatalogUpdate } from '../../../media/moq/parse-catalog';
import { utf8Decode, utf8Encode } from '../../../network/moqt/bytes';
import { StreamReader } from '../../../network/moqt/bytes';
import {
  type ControlMessage,
  ControlMessageDeframer,
  decodeControlMessage,
  encodeGoaway,
  encodePublish,
  encodeRequestUpdate,
  encodeSetup,
  encodeSubscribe,
  REQUEST_ERROR_CODE,
  SETUP_OPTION,
  TRACK_PROPERTY,
  type TrackNamespace,
} from '../../../network/moqt/control-messages';
import { type MoqtObject, readFetchHeader, STREAM_TYPE } from '../../../network/moqt/object-stream';
import { createMoqtSession, type MoqtSession } from '../../../network/moqt/session';
import {
  openRawRequest,
  rawSubscribe as rawSubscribeTo,
  solicitNamespace,
} from '../../../network/moqt/tests/helpers/raw-peer';
import { createTransportPair } from '../../../network/moqt/tests/helpers/transport-pair';
import { createTrackPublisherActor } from '../../actors/track-publisher';
import {
  composePublishConnectUrl,
  createMoqtPublishSession,
  createPublishSessionActor,
  type IncomingSubscribe,
  type MoqtPublishSessionCallbacks,
  type PublishSessionActorStatus,
} from '../publish-session';

const NAMESPACE = ['live', 'abc123'];

/** The relay's per-track pull under the test namespace. */
function rawSubscribe(server: Parameters<typeof rawSubscribeTo>[0], trackName: string, requestId: number) {
  return rawSubscribeTo(server, NAMESPACE, trackName, requestId);
}

function makePublishHarness(callbacks: MoqtPublishSessionCallbacks = {}) {
  const pair = createTransportPair();
  const subscriber = createMoqtSession(pair.server, { unknownAliasTimeoutMs: 500 });
  const session = createMoqtPublishSession(pair.client, { callbacks });

  return { pair, session, subscriber };
}

function collectTrack(
  subscriber: MoqtSession,
  trackName: string
): { objects: MoqtObject[]; aliases: number[]; subscription: ReturnType<MoqtSession['subscribe']> } {
  const objects: MoqtObject[] = [];
  const aliases: number[] = [];
  const subscription = subscriber.subscribe(
    { trackNamespace: NAMESPACE, trackName },
    {
      onOk: (ok) => aliases.push(ok.trackAlias),
      onObject: (object) => objects.push(object),
    }
  );

  return { objects, aliases, subscription };
}

/**
 * A publish session facing a raw peer with no subscribe driver: the peer completes SETUP by hand and watches the
 * publisher's uni streams for fill fetch streams, recording each FETCH_HEADER's Request ID and whether the publisher
 * reset the stream (the fill-failure signal) or FINed it. `finish()` destroys the session and releases the observer's
 * reader — the transport pair never ends its incoming-stream queues, so a pending `read()` would otherwise outlive the
 * test.
 */
async function makeFillHarness() {
  const pair = createTransportPair();
  const session = createMoqtPublishSession(pair.client);
  const fills: { requestId: number; reset: boolean }[] = [];
  const streams = pair.server.incomingUnidirectionalStreams.getReader();

  void (async () => {
    while (true) {
      const { done, value } = await streams.read();
      if (done) break;

      void (async () => {
        const reader = new StreamReader(value);
        const type = await reader.readVarint().catch(() => -1);
        if (type !== STREAM_TYPE.FETCH_HEADER) return;

        const { requestId } = await readFetchHeader(reader);

        // The publisher resets after the FETCH_HEADER; the drain throws.
        try {
          while (!(await reader.atEnd())) await reader.readUint8();

          fills.push({ requestId, reset: false });
        } catch {
          fills.push({ requestId, reset: true });
        }
      })();
    }
  })();

  const control = await pair.server.createUnidirectionalStream();

  await control.getWriter().write(encodeSetup());
  await session.ready;

  return {
    pair,
    session,
    fills,
    finish: async () => {
      session.destroy();
      await streams.cancel();
    },
  };
}

describe('createMoqtPublishSession', () => {
  it('completes SETUP both ways against the existing subscribe driver', async () => {
    const { session, subscriber } = makePublishHarness();

    await expect(session.ready).resolves.toBeUndefined();
    await expect(subscriber.ready).resolves.toBeUndefined();
    session.destroy();
    subscriber.destroy();
  });

  it('accepts a namespace solicitation and announces the namespace on it', async () => {
    const announced: TrackNamespace[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounced: ({ namespace }) => announced.push(namespace),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });
    // Empty prefix → the suffix is the full namespace.
    expect(solicitation.received[1]).toMatchObject({ kind: 'namespace', trackNamespaceSuffix: NAMESPACE });
    expect(announced).toEqual([NAMESPACE]);
    session.destroy();
    subscriber.destroy();
  });

  it('defers the announce until the first track is registered', async () => {
    const { pair, session, subscriber } = makePublishHarness();

    await session.ready;
    session.announce(NAMESPACE);

    // Solicited and announced, but nothing to serve yet: an announce now
    // would invite SUBSCRIBEs that DOES_NOT_EXIST terminally.
    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok']);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(solicitation.received).toHaveLength(1);

    // The first registration releases it.
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('announces on a solicitation that arrived before announce()', async () => {
    const announced: TrackNamespace[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounced: ({ namespace }) => announced.push(namespace),
    });

    await session.ready;

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok']);
    });

    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
      expect(announced).toEqual([NAMESPACE]);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('announces the suffix relative to a non-empty solicited prefix', async () => {
    const { pair, session, subscriber } = makePublishHarness();

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, ['live']);

    await vi.waitFor(() => {
      expect(solicitation.received).toHaveLength(2);
    });
    expect(solicitation.received[1]).toMatchObject({ kind: 'namespace', trackNamespaceSuffix: ['abc123'] });
    session.destroy();
    subscriber.destroy();
  });

  it('accepts but never announces on a solicitation whose prefix does not cover the namespace', async () => {
    const announced: TrackNamespace[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounced: ({ namespace }) => announced.push(namespace),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, ['other']);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok']);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(solicitation.received).toHaveLength(1);
    expect(announced).toEqual([]);
    session.destroy();
    subscriber.destroy();
  });

  it('reports onAnnounceEnded when the solicitation carrying the announce ends', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received).toHaveLength(2);
    });

    // The peer withdrawing the namespace subscription (a reset — a clean
    // FIN is only half-closure) takes the announce with it — the ingest
    // path is gone.
    void solicitation.reset();
    await vi.waitFor(() => {
      expect(endings).toHaveLength(1);
    });
    expect(endings[0]).toBeInstanceOf(Error);
    session.destroy();
    subscriber.destroy();
  });

  it('keeps the carrier alive across the requester half-closing its side', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });

    // §3.3.2: a clean requester FIN only commits to sending no updates —
    // it is not a withdrawal, and the response side keeps carrying the
    // announce.
    void solicitation.fin();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(endings).toEqual([]);

    // The carrier is still the retraction path at close().
    session.close();
    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace', 'namespace-done']);
    });
    subscriber.destroy();
  });

  it('rejects an overlapping namespace solicitation with PREFIX_OVERLAP', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const broad = await solicitNamespace(pair.server, [], 1);

    await vi.waitFor(() => {
      expect(broad.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });

    // §10.18: a second solicitation whose prefix nests with an
    // established one would produce duplicate namespace state — refused,
    // and the established carrier is untouched.
    const narrow = await solicitNamespace(pair.server, ['live'], 3);

    await vi.waitFor(() => {
      expect(narrow.received.map((m) => m.kind)).toEqual(['request-error']);
      expect(narrow.ended()).toBe(true);
    });
    expect(narrow.received[0]).toMatchObject({ errorCode: REQUEST_ERROR_CODE.PREFIX_OVERLAP });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broad.ended()).toBe(false);
    expect(endings).toEqual([]);
    session.destroy();
    subscriber.destroy();
  });

  it('holds the overlap guard across the acceptance write of a racing solicitation', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    // Both solicitations are in flight before either REQUEST_OK write
    // settles — request handlers run concurrently, so §10.18's
    // single-carrier rule must hold across the acceptance await, not
    // only at the synchronous check.
    const [broad, narrow] = await Promise.all([
      solicitNamespace(pair.server, [], 1),
      solicitNamespace(pair.server, ['live'], 3),
    ]);

    await vi.waitFor(() => {
      expect(broad.received.length).toBeGreaterThanOrEqual(1);
      expect(narrow.received.length).toBeGreaterThanOrEqual(1);
    });
    expect([broad.received[0]?.kind, narrow.received[0]?.kind].sort()).toEqual(['request-error', 'request-ok']);
    const refused = broad.received[0]?.kind === 'request-error' ? broad : narrow;
    const accepted = refused === broad ? narrow : broad;

    expect(refused.received[0]).toMatchObject({ errorCode: REQUEST_ERROR_CODE.PREFIX_OVERLAP });
    await vi.waitFor(() => {
      expect(accepted.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
      expect(refused.ended()).toBe(true);
    });
    expect(endings).toEqual([]);
    session.destroy();
    subscriber.destroy();
  });

  it('answers inbound SUBSCRIBE with the request id as the alias and routes REQUEST_UPDATE', async () => {
    const subscribes: IncomingSubscribe[] = [];
    const updates: { requestId: number; updateRequestId: number }[] = [];
    const bindings: { trackName: string; trackAlias: number | undefined }[] = [];
    const { session, subscriber } = makePublishHarness({
      onSubscribe: (subscribe) => subscribes.push(subscribe),
      onRequestUpdate: ({ requestId, updateRequestId }) => updates.push({ requestId, updateRequestId }),
      onTrackBinding: (binding) => bindings.push(binding),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const video = collectTrack(subscriber, 'video');

    await vi.waitFor(() => {
      // The peer's request ids are session-unique, so they double as the
      // alias — two live request ids sharing an alias is a session-fatal
      // Duplicate on moq-lite-rs.
      expect(video.aliases).toEqual([video.subscription.requestId]);
      expect(subscribes.map((s) => s.trackName)).toEqual(['video']);
      expect(bindings).toEqual([{ trackName: 'video', trackAlias: video.subscription.requestId }]);
    });

    // The ack lands as the driver's update completion (`onUpdateOk` sits
    // in the subscribe-time handlers).
    const updateAcks: number[] = [];
    const updated = subscriber.subscribe(
      { trackNamespace: NAMESPACE, trackName: 'video' },
      { onUpdateOk: () => updateAcks.push(1) }
    );

    await vi.waitFor(() => {
      expect(subscribes).toHaveLength(2);
    });
    updated.update({ subscriberPriority: 9 });
    await vi.waitFor(() => {
      // The update is attributed to the subscription it rode in on, while
      // consuming a Request ID of its own (§10.1).
      expect(updates).toEqual([{ requestId: updated.requestId, updateRequestId: expect.any(Number) }]);
      expect(updates[0]?.updateRequestId).not.toBe(updated.requestId);
      expect(updateAcks).toHaveLength(1);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('declares the microsecond timescale in SUBSCRIBE_OK track properties', async () => {
    const { pair, session, subscriber } = makePublishHarness();

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const subscribe = await rawSubscribe(pair.server, 'video', 11);

    await vi.waitFor(() => {
      expect(subscribe.received).toHaveLength(1);
    });
    // Undeclared, moq-lite-rs relays parse and DISCARD the objects'
    // TIMESTAMP extensions and re-stamp frames on arrival — viewers would
    // sync to relay arrival time instead of capture time.
    expect(subscribe.received[0]).toMatchObject({
      kind: 'subscribe-ok',
      trackAlias: 11,
      trackProperties: [{ type: TRACK_PROPERTY.TIMESCALE, value: 1_000_000 }],
    });
    session.destroy();
    subscriber.destroy();
  });

  it('rejects inbound SUBSCRIBE for unknown tracks with DOES_NOT_EXIST', async () => {
    const { session, subscriber } = makePublishHarness();

    await session.ready;

    const errors: number[] = [];

    subscriber.subscribe(
      { trackNamespace: NAMESPACE, trackName: 'nope' },
      { onError: (error) => errors.push(error.errorCode) }
    );
    await vi.waitFor(() => {
      expect(errors).toEqual([REQUEST_ERROR_CODE.DOES_NOT_EXIST]);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('ends a track by FINing its subscription streams with no trailing message', async () => {
    const endedRequests: number[] = [];
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onSubscribeEnd: ({ requestId }) => endedRequests.push(requestId),
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    const track = session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const subscribe = await rawSubscribe(pair.server, 'video', 21);

    await vi.waitFor(() => {
      expect(subscribe.received).toHaveLength(1);
    });

    track.end();
    // The local end is authoritative: the subscription is reported ended
    // and the binding cleared immediately — not when the peer eventually
    // closes its request direction.
    expect(endedRequests).toEqual([21]);
    expect(bindings.at(-1)).toBeUndefined();
    await vi.waitFor(() => {
      expect(subscribe.ended()).toBe(true);
    });
    // A bare FIN is the clean track end. Any byte after
    // SUBSCRIBE_OK — the old PUBLISH_DONE — makes moq-lite-rs abort the
    // track for every downstream viewer instead of finishing it.
    expect(subscribe.received.map((m) => m.kind)).toEqual(['subscribe-ok']);

    // The peer closing its side afterwards must not double-report.
    void subscribe.fin();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(endedRequests).toEqual([21]);
    session.destroy();
    subscriber.destroy();
  });

  it('hands the binding to the newest subscription and FINs the replaced stream', async () => {
    const bindings: (number | undefined)[] = [];
    const endedRequests: number[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
      onSubscribeEnd: ({ requestId }) => endedRequests.push(requestId),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const first = await rawSubscribe(pair.server, 'video', 31);

    await vi.waitFor(() => {
      expect(first.received).toHaveLength(1);
    });

    const second = await rawSubscribe(pair.server, 'video', 33);

    await vi.waitFor(() => {
      expect(second.received).toHaveLength(1);
      // The replaced subscription ends cleanly (FIN, no trailing bytes).
      expect(first.ended()).toBe(true);
    });
    expect(first.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    // The relay closes its own side after seeing ours; only then does the
    // replaced subscription's stream fully end.
    void first.fin();
    await vi.waitFor(() => {
      expect(endedRequests).toEqual([31]);
    });
    // Rebinding lands on the newest alias; the replaced stream's own end
    // re-derives the same binding rather than clearing it.
    expect(bindings[0]).toBe(31);
    expect(bindings[bindings.length - 1]).toBe(33);
    expect(bindings).not.toContain(undefined);
    session.destroy();
    subscriber.destroy();
  });

  it('converges on the newest subscription regardless of acceptance order', async () => {
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // Both SUBSCRIBEs land with their acceptances backpressured (unread
    // responses); the OLDER one is then released first.
    const openHeld = async (requestId: number) => {
      const stream = await pair.server.createBidirectionalStream();
      const writer = stream.writable.getWriter();

      await writer.write(encodeSubscribe({ requestId, trackNamespace: NAMESPACE, trackName: 'video', parameters: {} }));
      let ended = false;

      return {
        ended: () => ended,
        drain: () => {
          void (async () => {
            const reader = stream.readable.getReader();

            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          })().then(
            () => {
              ended = true;
            },
            () => {
              ended = true;
            }
          );
        },
      };
    };
    const older = await openHeld(91);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = await openHeld(93);

    await new Promise((resolve) => setTimeout(resolve, 20));

    // Older accepts first — it may bind transiently, but must not sweep
    // the newer request that arrived after it.
    older.drain();
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(91);
    });

    // The newer acceptance lands and takes the binding; the older is
    // FINed as its predecessor.
    newer.drain();
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(93);
      expect(older.ended()).toBe(true);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('a stale acceptance does not steal the binding from a newer subscription', async () => {
    const bindings: (number | undefined)[] = [];
    const subscribed: number[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
      onSubscribe: ({ requestId }) => subscribed.push(requestId),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // Subscription A: write the SUBSCRIBE but do NOT read the response —
    // over the in-memory pair a write only settles once the far side
    // reads, so A's SUBSCRIBE_OK hangs in flight.
    const streamA = await pair.server.createBidirectionalStream();
    const writerA = streamA.writable.getWriter();

    await writerA.write(
      encodeSubscribe({ requestId: 61, trackNamespace: NAMESPACE, trackName: 'video', parameters: {} })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Subscription B reads immediately: its acceptance settles first,
    // replaces A, and takes the binding.
    const b = await rawSubscribe(pair.server, 'video', 63);

    await vi.waitFor(() => {
      expect(b.received).toHaveLength(1);
      expect(bindings.at(-1)).toBe(63);
    });

    // Now drain A: its stale acceptance completes against a subscription
    // that was already replaced — it must not rebind the track.
    const readerA = streamA.readable.getReader();

    void (async () => {
      while (true) {
        const { done } = await readerA.read();
        if (done) break;
      }
    })().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bindings).not.toContain(61);
    expect(bindings.at(-1)).toBe(63);
    // The swept-while-pending subscription was never live, so it is never
    // reported — subscriber counts stay balanced.
    expect(subscribed).toEqual([63]);
    session.destroy();
    subscriber.destroy();
  });

  it('withholds the binding while Forward State is 0 and follows REQUEST_UPDATE toggles', async () => {
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // `forward: 0` subscribes without authorizing data.
    const sub = await openRawRequest(
      pair.server,
      encodeSubscribe({ requestId: 81, trackNamespace: NAMESPACE, trackName: 'video', parameters: { forward: 0 } })
    );

    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
      expect(bindings).toEqual([undefined]);
    });

    // Each REQUEST_UPDATE consumes a Request ID of its own (§10.1).
    await sub.send(encodeRequestUpdate(83, { forward: 1 }));
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(81);
    });

    await sub.send(encodeRequestUpdate(85, { forward: 0 }));
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBeUndefined();
    });
    // Each accepted update is acknowledged — the subscribe driver treats
    // REQUEST_OK as the update's completion. (The binding update above is
    // synchronous server-side while the ack rides the transport, so this
    // must wait too.)
    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok', 'request-ok', 'request-ok']);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('sweeps every live predecessor when a new subscription takes the binding', async () => {
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // A: fully accepted and bound.
    const a = await rawSubscribe(pair.server, 'video', 71);

    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(71);
    });

    // B: acceptance held in flight (unread response).
    const streamB = await pair.server.createBidirectionalStream();
    const writerB = streamB.writable.getWriter();

    await writerB.write(
      encodeSubscribe({ requestId: 73, trackNamespace: NAMESPACE, trackName: 'video', parameters: {} })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // C settles first and must sweep BOTH A and B — leaving A live would
    // let it reclaim the binding when C ends.
    const c = await rawSubscribe(pair.server, 'video', 75);

    await vi.waitFor(() => {
      expect(c.received).toHaveLength(1);
      expect(bindings.at(-1)).toBe(75);
      expect(a.ended()).toBe(true);
    });

    // C ends (the relay closes both directions): the binding clears
    // instead of falling back to the superseded A.
    void c.fin();
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBeUndefined();
    });
    expect(bindings.filter((alias) => alias === 71)).toEqual([71]);
    session.destroy();
    subscriber.destroy();
  });

  it('surfaces the announce loss when only the response half of the solicitation dies', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok']);
    });

    // The peer resets only the response direction; its request half — the
    // read loop's end signal — stays open, so the entry write's failure
    // is the only evidence the carrier is unusable.
    await solicitation.abandonReads();
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    await vi.waitFor(() => {
      expect(endings).toHaveLength(1);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('accepts a replacement solicitation after the response half of the carrier dies', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;

    const dead = await solicitNamespace(pair.server, [], 1);

    await vi.waitFor(() => {
      expect(dead.received.map((m) => m.kind)).toEqual(['request-ok']);
    });
    await dead.abandonReads();
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    await vi.waitFor(() => {
      expect(endings).toHaveLength(1);
    });

    // The write failure deregistered the dead carrier along with the
    // loss report, so the relay's retry is a fresh start — not a
    // PREFIX_OVERLAP refusal against a corpse.
    const retry = await solicitNamespace(pair.server, [], 3);

    await vi.waitFor(() => {
      expect(retry.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('rejects a namespace REQUEST_UPDATE and closes the carrier, never the session', async () => {
    const updates: number[] = [];
    const closes: unknown[] = [];
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onRequestUpdate: ({ requestId }) => updates.push(requestId),
      onClosed: (info) => closes.push(info),
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received).toHaveLength(2);
    });

    // A legal §10.9 update (on a fresh Request ID) must never be
    // session-fatal; v1 applies no prefix changes, so per §10.9.1 the
    // update is answered with an error and the request stream closes —
    // which costs the announce carrier, surfaced as announce loss.
    await solicitation.send(encodeRequestUpdate(3, { subscriberPriority: 5 }));
    await vi.waitFor(() => {
      expect(updates).toEqual([1]);
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace', 'request-error']);
      expect(solicitation.ended()).toBe(true);
      expect(endings).toHaveLength(1);
    });
    expect(closes).toEqual([]);
    session.destroy();
    subscriber.destroy();
  });

  it('closes the session when the peer reuses a request id', async () => {
    const closes: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onClosed: (info) => closes.push(info),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'audio' });

    const first = await rawSubscribe(pair.server, 'video', 101);

    await vi.waitFor(() => {
      expect(first.received).toHaveLength(1);
    });

    // Aliases ARE the peer's request ids: a reused id would hand two
    // tracks the same alias and make their subgroup streams
    // indistinguishable — protocol violation, session-fatal.
    await rawSubscribe(pair.server, 'audio', 101);
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
    expect((closes[0] as { error?: unknown }).error).toBeInstanceOf(Error);
    subscriber.destroy();
  });

  it('closes the session when a REQUEST_UPDATE reuses a request id', async () => {
    const closes: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onClosed: (info) => closes.push(info),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const sub = await rawSubscribe(pair.server, 'video', 111);

    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    });

    // REQUEST_UPDATE consumes a Request ID of its own (§10.1); riding on
    // the subscription's id is the same duplicate as a repeated SUBSCRIBE.
    await sub.send(encodeRequestUpdate(111, { subscriberPriority: 9 }));
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
    expect((closes[0] as { error?: unknown }).error).toBeInstanceOf(Error);
    subscriber.destroy();
  });

  it('reserves request ids across every inbound request kind', async () => {
    const closes: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onClosed: (info) => closes.push(info),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // A rejected PUBLISH burns its id session-wide…
    const publish = await openRawRequest(
      pair.server,
      encodePublish({ requestId: 121, trackNamespace: NAMESPACE, trackName: 'video', trackAlias: 9 })
    );

    await vi.waitFor(() => {
      expect(publish.received.map((m) => m.kind)).toEqual(['request-error']);
    });
    expect(closes).toEqual([]);

    // …so a later SUBSCRIBE cannot reuse it as an alias.
    await rawSubscribe(pair.server, 'video', 121);
    await vi.waitFor(() => {
      expect(closes).toHaveLength(1);
    });
    subscriber.destroy();
  });

  it('reports the track Largest Object in SUBSCRIBE_OK once content exists', async () => {
    const { pair, session, subscriber } = makePublishHarness();

    await session.ready;
    let largest: { group: number; object: number } | undefined;

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video', getLargestObject: () => largest });

    // No content yet — SUBSCRIBE_OK omits LARGEST_OBJECT (§10.2.17).
    const early = await rawSubscribe(pair.server, 'video', 201);

    await vi.waitFor(() => {
      expect(early.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    });
    const earlyOk = early.received[0];

    expect(earlyOk?.kind).toBe('subscribe-ok');

    if (earlyOk?.kind === 'subscribe-ok') expect(earlyOk.parameters.largestObject).toBeUndefined();

    // Once objects have been written, the next SUBSCRIBE_OK carries it
    // (length-prefixed, the way moq-lite-rs decodes it).
    largest = { group: 35, object: 28 };
    const later = await rawSubscribe(pair.server, 'video', 203);

    await vi.waitFor(() => {
      expect(later.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    });
    const laterOk = later.received[0];

    expect(laterOk?.kind).toBe('subscribe-ok');

    if (laterOk?.kind === 'subscribe-ok') expect(laterOk.parameters.largestObject).toEqual({ group: 35, object: 28 });

    session.destroy();
    subscriber.destroy();
  });

  it('opens and resets a fill fetch stream for an inbound FILL_PARAMETERS', async () => {
    const { pair, session, fills, finish } = await makeFillHarness();

    session.registerTrack({
      trackNamespace: NAMESPACE,
      trackName: 'video',
      getLargestObject: () => ({ group: 4, object: 2 }),
    });

    await openRawRequest(
      pair.server,
      encodeSubscribe({
        requestId: 205,
        trackNamespace: NAMESPACE,
        trackName: 'video',
        parameters: {
          forward: 1,
          locationFilter: { type: 'next-object' },
          fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 1 } },
        },
      })
    );

    await vi.waitFor(() => {
      expect(fills).toEqual([{ requestId: 205, reset: true }]);
    });
    await finish();
  });

  it('opens no fill fetch stream for an empty fill range (§5.1.3)', async () => {
    const { pair, session, fills, finish } = await makeFillHarness();
    let largest: { group: number; object: number } | undefined;

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video', getLargestObject: () => largest });
    const subscribeWithFill = async (requestId: number, fill: Parameters<typeof encodeSubscribe>[0]['parameters']) => {
      const request = await openRawRequest(
        pair.server,
        encodeSubscribe({
          requestId,
          trackNamespace: NAMESPACE,
          trackName: 'video',
          parameters: { forward: 1, locationFilter: { type: 'next-object' }, ...fill },
        })
      );

      await vi.waitFor(() => {
        expect(request.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
      });
    };

    // Nothing published yet: there is nothing to fill, whatever the filter.
    await subscribeWithFill(207, {
      fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 1 } },
    });

    // With content, a fill from the Next Object or the Next Group starts
    // past Largest Object, and an omitted fill filter inherits the
    // subscription's Next Object filter.
    largest = { group: 4, object: 2 };
    await subscribeWithFill(209, { fillParameters: { locationFilter: { type: 'next-object' } } });
    await subscribeWithFill(211, {
      fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 0 } },
    });
    await subscribeWithFill(213, { fillParameters: {} });

    // Control: a fill of the current group is nonempty and is answered —
    // and it is the only fill stream the peer ever saw.
    await subscribeWithFill(215, {
      fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 1 } },
    });
    await vi.waitFor(() => {
      expect(fills).toEqual([{ requestId: 215, reset: true }]);
    });
    await finish();
  });

  it('keys a fill requested by REQUEST_UPDATE to the update Request ID', async () => {
    const { pair, session, fills, finish } = await makeFillHarness();

    session.registerTrack({
      trackNamespace: NAMESPACE,
      trackName: 'video',
      getLargestObject: () => ({ group: 4, object: 2 }),
    });
    const sub = await rawSubscribe(pair.server, 'video', 217);

    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    });

    // An empty-range fill is acknowledged like any update but opens no
    // stream; a nonempty one opens (and resets) a stream carrying the
    // update's own Request ID, not the subscription's.
    await sub.send(encodeRequestUpdate(219, { fillParameters: { locationFilter: { type: 'next-object' } } }));
    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok', 'request-ok']);
    });
    await sub.send(
      encodeRequestUpdate(221, { fillParameters: { locationFilter: { type: 'relative-group', groupsBeforeNext: 1 } } })
    );
    await vi.waitFor(() => {
      expect(fills).toEqual([{ requestId: 221, reset: true }]);
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok', 'request-ok', 'request-ok']);
    });
    await finish();
  });

  it('rejects a subscription update it cannot apply instead of acknowledging it', async () => {
    const endedRequests: number[] = [];
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onSubscribeEnd: ({ requestId }) => endedRequests.push(requestId),
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const sub = await rawSubscribe(pair.server, 'video', 111);

    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(111);
    });

    // A filter change is not applied — acknowledging it would leave the
    // peer believing its new range is in effect.
    await sub.send(encodeRequestUpdate(113, { locationFilter: { type: 'relative-group', groupsBeforeNext: 0 } }));
    await vi.waitFor(() => {
      expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok', 'request-error']);
      expect(sub.ended()).toBe(true);
      expect(endedRequests).toEqual([111]);
      expect(bindings.at(-1)).toBeUndefined();
    });
    session.destroy();
    subscriber.destroy();
  });

  it('treats announce-carrier loss after a GOAWAY as migration, not failure', async () => {
    const goaways: number[] = [];
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onGoaway: (goaway) => goaways.push(goaway.timeout),
      onAnnounceEnded: ({ error }) => endings.push(error),
    });

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received).toHaveLength(2);
    });

    // The peer migrates: GOAWAY, then its streams drain. The announce
    // ending here is the orderly drain — surfacing it as a failure would
    // override the actor's 'draining' with 'failed'.
    await solicitation.send(encodeGoaway(1500));
    await vi.waitFor(() => {
      expect(goaways).toEqual([1500]);
    });
    void solicitation.reset();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(endings).toEqual([]);
    session.destroy();
    subscriber.destroy();
  });

  it('clears the binding when the only subscription ends', async () => {
    const bindings: (number | undefined)[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackAlias }) => bindings.push(trackAlias),
    });

    await session.ready;
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const subscribe = await rawSubscribe(pair.server, 'video', 41);

    await vi.waitFor(() => {
      expect(bindings).toEqual([41]);
    });

    void subscribe.fin();
    await vi.waitFor(() => {
      expect(bindings).toEqual([41, undefined]);
      // The response direction closes too — a peer-initiated unsubscribe
      // must not leak a half-open stream.
      expect(subscribe.ended()).toBe(true);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('close() drains the FINs and NAMESPACE_DONE to the wire without a GOAWAY', async () => {
    const pair = createTransportPair();
    // A fully raw peer: complete SETUP and record every frame on the
    // publisher's control stream — it must carry SETUP and nothing else
    // (a client GOAWAY closes a moq-lite-rs session, code 17).
    const controlFrames: ControlMessage[] = [];

    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();

      await writer.write(encodeSetup([]));
      const reader = pair.server.incomingUnidirectionalStreams.getReader();
      const { value: publisherControl } = await reader.read();
      const deframer = new ControlMessageDeframer();
      const streamReader = publisherControl!.getReader();

      while (true) {
        const { done, value } = await streamReader.read().catch(() => ({ done: true, value: undefined }) as const);
        if (done) break;

        for (const frame of deframer.push(value!)) controlFrames.push(decodeControlMessage(frame));
      }
    })();
    const session = createMoqtPublishSession(pair.client);

    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const solicitation = await solicitNamespace(pair.server, []);
    const subscribe = await rawSubscribe(pair.server, 'video', 51);

    await vi.waitFor(() => {
      expect(solicitation.received).toHaveLength(2);
      expect(subscribe.received).toHaveLength(1);
    });

    session.close();
    await vi.waitFor(() => {
      // The announce is retracted and the subscription FINed cleanly
      // before the transport goes away.
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace', 'namespace-done']);
      expect(subscribe.ended()).toBe(true);
    });
    expect(subscribe.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
    expect(controlFrames.map((m) => m.kind)).toEqual(['setup']);
  });

  it('close() leaves no timer running', async () => {
    vi.useFakeTimers();

    try {
      const pair = createTransportPair();

      void (async () => {
        const control = await pair.server.createUnidirectionalStream();
        const writer = control.getWriter();

        await writer.write(encodeSetup([]));
      })();
      const session = createMoqtPublishSession(pair.client);

      await session.ready;
      session.close();
      // Room for the close drain's own (self-clearing) timers.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registerTrack() after destroy is inert — no track state, end() safe', async () => {
    const { session, subscriber } = makePublishHarness();

    await session.ready;
    session.destroy();

    const handle = session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'late' });

    expect(handle.trackName).toBe('late');
    expect(() => handle.end()).not.toThrow();
    subscriber.destroy();
  });

  it('surfaces a control-stream GOAWAY', async () => {
    const pair = createTransportPair();

    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();

      await writer.write(encodeSetup([]));
      await writer.write(encodeGoaway(1500));
    })();
    const goaways: number[] = [];
    const session = createMoqtPublishSession(pair.client, {
      callbacks: { onGoaway: (goaway) => goaways.push(goaway.timeout) },
    });

    await session.ready;
    await vi.waitFor(() => {
      expect(goaways).toEqual([1500]);
    });
    session.destroy();
  });

  // ---------------------------------------------------------------------------
  // The end-to-end proof: publish session ↔ existing subscribe driver.
  // ---------------------------------------------------------------------------

  it('delivers a parseable catalog and LOC frames end to end over solicited subscriptions', async () => {
    const bindings = new Map<string, number | undefined>();
    const { pair, session, subscriber } = makePublishHarness({
      onTrackBinding: ({ trackName, trackAlias }) => bindings.set(trackName, trackAlias),
    });

    await session.ready;
    await subscriber.ready;

    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(solicitation.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    // Publishers start unbound — nothing may hit the wire until the peer
    // subscribes and the binding lands (the behavior layer's job; the
    // test wires it directly).
    const catalogPublisher = createTrackPublisherActor({
      openUniStream: () => session.openUniStream(),
      groupPerFrame: true,
      replayLastGroupOnBind: true,
    });
    const videoPublisher = createTrackPublisherActor({
      openUniStream: () => session.openUniStream(),
    });

    // The catalog frame goes out BEFORE any subscription exists — the
    // replay-on-bind latch must deliver it to the late subscriber.
    const catalogJson = JSON.stringify({
      version: 'draft-01',
      tracks: [{ name: 'video', packaging: 'loc', isLive: true, role: 'video', codec: 'vp8' }],
    });

    catalogPublisher.send({
      type: 'frame',
      payload: utf8Encode(catalogJson),
      properties: [],
      keyframe: true,
      timestampUs: 0,
    });

    const catalog = collectTrack(subscriber, 'catalog');
    const video = collectTrack(subscriber, 'video');

    await vi.waitFor(() => {
      expect(bindings.get('catalog')).toBeDefined();
      expect(bindings.get('video')).toBeDefined();
    });
    catalogPublisher.send({ type: 'bind', trackAlias: bindings.get('catalog')! });
    videoPublisher.send({ type: 'bind', trackAlias: bindings.get('video')! });

    // Two groups of LOC video frames (keyframe → new group).
    const frames = [
      { data: [1, 1, 1], timestampUs: 0, key: true },
      { data: [2, 2], timestampUs: 33_333, key: false },
      { data: [3], timestampUs: 2_000_000, key: true },
    ];

    for (const frame of frames) {
      const data = new Uint8Array(frame.data);
      const packaged = packageLocFrame(
        {
          type: frame.key ? 'key' : 'delta',
          timestamp: frame.timestampUs,
          byteLength: data.length,
          copyTo: (destination: Uint8Array) => destination.set(data),
        },
        frame.key ? { videoConfig: new Uint8Array([0xc0]) } : {}
      );

      videoPublisher.send({
        type: 'frame',
        payload: packaged.payload,
        properties: packaged.properties,
        keyframe: frame.key,
        timestampUs: frame.timestampUs,
      });
    }

    // The subscriber sees the replayed catalog object.
    await vi.waitFor(() => {
      expect(catalog.objects).toHaveLength(1);
    });
    const parsed = applyMoqCatalogUpdate(undefined, utf8Decode(catalog.objects[0]!.payload), {
      catalogNamespace: NAMESPACE,
    });

    expect(parsed.tracks.map((track) => track.name)).toEqual(['video']);
    expect(parsed.tracks[0]!.packaging).toBe('loc');

    // The subscriber sees the LOC frames with correct group/object numbering.
    await vi.waitFor(() => {
      expect(video.objects).toHaveLength(3);
    });
    expect(video.objects.map((o) => [o.groupId, o.objectId])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    const extracted = video.objects.map((object) => toLocFrame(object)!);

    expect(extracted.map((frame) => frame.isKey)).toEqual([true, false, true]);
    expect(extracted.map((frame) => frame.timestampUs)).toEqual([0, 33_333, 2_000_000]);
    expect(extracted[0]!.payload).toEqual(new Uint8Array([1, 1, 1]));
    expect(extracted[0]!.videoConfig).toEqual(new Uint8Array([0xc0]));

    videoPublisher.destroy();
    catalogPublisher.destroy();
    session.destroy();
    subscriber.destroy();
  });
});

describe('createPublishSessionActor', () => {
  it('walks connecting → ready → live on the announce and tracks subscribers and bindings', async () => {
    const pair = createTransportPair();
    const subscriber = createMoqtSession(pair.server, {});
    const statuses: PublishSessionActorStatus[] = [];
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });
    const record = () => {
      const status = actor.snapshot.get().context.status;

      if (statuses.at(-1) !== status) statuses.push(status);
    };

    record();

    await vi.waitFor(() => {
      record();
      expect(actor.snapshot.get().context.status).toBe('ready');
    });

    // A track registers (the behavior layer's job) and the relay's
    // solicitation arrives; the actor's announce answers it.
    const session = actor.snapshot.get().context.session!;

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    void solicitNamespace(pair.server, []);
    await vi.waitFor(() => {
      record();
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    expect(statuses).toEqual(['connecting', 'ready', 'live']);

    const subscription = subscriber.subscribe({ trackNamespace: NAMESPACE, trackName: 'video' }, {});

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.subscriberCount).toBe(1);
      expect(actor.snapshot.get().context.trackBindings).toEqual({ video: subscription.requestId });
    });

    actor.destroy();
    subscriber.destroy();
  });

  it('stays ready when the peer never solicits the namespace', async () => {
    const pair = createTransportPair();

    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();

      await writer.write(encodeSetup([]));
    })();
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(actor.snapshot.get().context.status).toBe('ready');
    actor.destroy();
  });

  it('moves to failed when the solicitation carrying the announce ends', async () => {
    const pair = createTransportPair();

    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();

      await writer.write(encodeSetup([]));
    })();
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    actor.snapshot.get().context.session!.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    const solicitation = await solicitNamespace(pair.server, []);

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('live');
    });

    void solicitation.reset();
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('failed');
    });
    expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);
    actor.destroy();
  });

  it('moves to draining on GOAWAY', async () => {
    const pair = createTransportPair();

    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();

      await writer.write(encodeSetup([]));
      await writer.write(encodeGoaway(0));
    })();
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('draining');
    });
    actor.destroy();
  });

  it('moves to failed when the transport cannot connect', async () => {
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => {
        throw new Error('connect refused');
      },
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('failed');
    });
    expect((actor.snapshot.get().context.error as Error).message).toBe('connect refused');
    actor.destroy();
  });

  // The known relay fleet (moq-lite-rs lineage) hard-closes the session on
  // AUTHORIZATION_TOKEN request parameters — the token must ride ONLY in
  // the connect URL (`composePublishConnectUrl`).
  it('keeps AUTHORIZATION_TOKEN request parameters off the wire even with an endpoint token', async () => {
    const pair = createTransportPair();
    const setupOptions: { type: number }[] = [];

    void (async () => {
      const reader = pair.server.incomingUnidirectionalStreams.getReader();
      const { value: control } = await reader.read();
      const deframer = new ControlMessageDeframer();
      const streamReader = control!.getReader();
      const { value } = await streamReader.read();

      for (const frame of deframer.push(value!)) {
        const message = decodeControlMessage(frame);

        if (message.kind === 'setup') setupOptions.push(...message.options);
      }
    })();
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE, authToken: 'secret' },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });

    await vi.waitFor(() => {
      expect(setupOptions.length).toBeGreaterThan(0);
    });
    expect(setupOptions.map((option) => option.type)).not.toContain(SETUP_OPTION.AUTHORIZATION_TOKEN);
    actor.destroy();
  });
});

describe('composePublishConnectUrl', () => {
  it('appends the token as a jwt query parameter (kixelated-relay convention)', () => {
    expect(composePublishConnectUrl('https://relay.example.com:4443', 'tok')).toBe(
      'https://relay.example.com:4443/?jwt=tok'
    );
    expect(composePublishConnectUrl('https://relay.example.com/moq?keep=1', 'tok')).toBe(
      'https://relay.example.com/moq?keep=1&jwt=tok'
    );
  });

  it('leaves the URL alone without a token or with an explicit jwt parameter', () => {
    expect(composePublishConnectUrl('https://relay.example.com/moq')).toBe('https://relay.example.com/moq');
    expect(composePublishConnectUrl('https://relay.example.com/?jwt=mine', 'tok')).toBe(
      'https://relay.example.com/?jwt=mine'
    );
  });

  it('returns an unparseable URL verbatim so WebTransport raises the canonical error', () => {
    expect(composePublishConnectUrl('not a url', 'tok')).toBe('not a url');
  });
});
