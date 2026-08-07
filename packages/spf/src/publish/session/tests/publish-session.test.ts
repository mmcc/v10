import { describe, expect, it, vi } from 'vitest';
import { toLocFrame } from '../../../media/moq/loc';
import { packageLocFrame } from '../../../media/moq/loc-packaging';
import { applyMoqCatalogUpdate } from '../../../media/moq/parse-catalog';
import { utf8Decode, utf8Encode } from '../../../network/moqt/bytes';
import {
  type ControlMessage,
  ControlMessageDeframer,
  decodeControlMessage,
  encodeGoaway,
  encodeRequestUpdate,
  encodeSetup,
  encodeSubscribe,
  REQUEST_ERROR_CODE,
  SETUP_OPTION,
  TRACK_PROPERTY,
  type TrackNamespace,
} from '../../../network/moqt/control-messages';
import type { MoqtObject } from '../../../network/moqt/object-stream';
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

    // The peer withdrawing the namespace subscription takes the announce
    // with it — the ingest path is gone.
    void solicitation.fin();
    await vi.waitFor(() => {
      expect(endings).toHaveLength(1);
    });
    expect(endings[0]).toBeInstanceOf(Error);
    session.destroy();
    subscriber.destroy();
  });

  it('keeps the announce alive while another solicitation still carries it', async () => {
    const endings: unknown[] = [];
    const { pair, session, subscriber } = makePublishHarness({
      onAnnounceEnded: ({ error }) => endings.push(error),
    });
    await session.ready;
    session.announce(NAMESPACE);
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });

    // Two covering prefixes — a token may grant several.
    const broad = await solicitNamespace(pair.server, [], 1);
    const narrow = await solicitNamespace(pair.server, ['live'], 3);
    await vi.waitFor(() => {
      expect(broad.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
      expect(narrow.received.map((m) => m.kind)).toEqual(['request-ok', 'namespace']);
    });

    // One carrier ends: the other still carries the announce, so the
    // ingest path is intact and no loss is reported.
    void broad.fin();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(endings).toEqual([]);

    // The last carrier ending is the real loss.
    void narrow.fin();
    await vi.waitFor(() => {
      expect(endings).toHaveLength(1);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('answers inbound SUBSCRIBE with the request id as the alias and routes REQUEST_UPDATE', async () => {
    const subscribes: IncomingSubscribe[] = [];
    const updates: { requestId: number }[] = [];
    const bindings: { trackName: string; trackAlias: number | undefined }[] = [];
    const { session, subscriber } = makePublishHarness({
      onSubscribe: (subscribe) => subscribes.push(subscribe),
      onRequestUpdate: (update) => updates.push({ requestId: update.requestId }),
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
      expect(updates).toEqual([{ requestId: updated.requestId }]);
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
    const { pair, session, subscriber } = makePublishHarness();
    await session.ready;
    const track = session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const subscribe = await rawSubscribe(pair.server, 'video', 21);
    await vi.waitFor(() => {
      expect(subscribe.received).toHaveLength(1);
    });

    track.end();
    await vi.waitFor(() => {
      expect(subscribe.ended()).toBe(true);
    });
    // A bare FIN is the draft-19 clean track end. Any byte after
    // SUBSCRIBE_OK — the old PUBLISH_DONE — makes moq-lite-rs abort the
    // track for every downstream viewer instead of finishing it.
    expect(subscribe.received.map((m) => m.kind)).toEqual(['subscribe-ok']);
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

    await sub.send(encodeRequestUpdate(81, { forward: 1 }));
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBe(81);
    });

    await sub.send(encodeRequestUpdate(81, { forward: 0 }));
    await vi.waitFor(() => {
      expect(bindings.at(-1)).toBeUndefined();
    });
    // Each accepted update is acknowledged — the subscribe driver treats
    // REQUEST_OK as the update's completion.
    expect(sub.received.map((m) => m.kind)).toEqual(['subscribe-ok', 'request-ok', 'request-ok']);
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
    void solicitation.fin();
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

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
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

    void solicitation.fin();
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
  // draft-19 AUTHORIZATION_TOKEN structures — the token must ride ONLY in
  // the connect URL (`composePublishConnectUrl`).
  it('keeps draft-19 auth structures off the wire even with an endpoint token', async () => {
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
