import { describe, expect, it, vi } from 'vitest';
import { toLocFrame } from '../../../media/moq/loc';
import { packageLocFrame } from '../../../media/moq/loc-packaging';
import { applyMoqCatalogUpdate } from '../../../media/moq/parse-catalog';
import { utf8Decode, utf8Encode } from '../../../network/moqt/bytes';
import {
  ControlMessageDeframer,
  decodeControlMessage,
  encodeGoaway,
  encodeRequestOk,
  encodeSetup,
  PUBLISH_DONE_STATUS,
  REQUEST_ERROR_CODE,
  SETUP_OPTION,
} from '../../../network/moqt/control-messages';
import type { MoqtObject } from '../../../network/moqt/object-stream';
import { createMoqtSession, type MoqtSession, type PublishDone } from '../../../network/moqt/session';
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

/** A subscribe-side peer (the EXISTING driver) that accepts every PUBLISH. */
function makeSubscriberPeer(server: Parameters<typeof createMoqtSession>[0]) {
  const publishes: { trackName: string; trackAlias: number }[] = [];
  const session = createMoqtSession(server, {
    unknownAliasTimeoutMs: 500,
    callbacks: {
      onIncomingPublish: (publish, respond) => {
        publishes.push({ trackName: publish.trackName, trackAlias: publish.trackAlias });
        respond.accept();
      },
    },
  });
  return { session, publishes };
}

function makePublishHarness(callbacks: MoqtPublishSessionCallbacks = {}, requestTimeoutMs = 1000) {
  const pair = createTransportPair();
  const peer = makeSubscriberPeer(pair.server);
  const session = createMoqtPublishSession(pair.client, { requestTimeoutMs, callbacks });
  return { pair, session, subscriber: peer.session, publishes: peer.publishes };
}

function collectTrack(
  subscriber: MoqtSession,
  trackName: string
): { objects: MoqtObject[]; done: PublishDone[]; subscription: ReturnType<MoqtSession['subscribe']> } {
  const objects: MoqtObject[] = [];
  const done: PublishDone[] = [];
  const subscription = subscriber.subscribe(
    { trackNamespace: NAMESPACE, trackName },
    {
      onObject: (object) => objects.push(object),
      onDone: (info) => done.push(info),
    }
  );
  return { objects, done, subscription };
}

describe('createMoqtPublishSession', () => {
  it('completes SETUP both ways against the existing subscribe driver', async () => {
    const { session, subscriber } = makePublishHarness();
    await expect(session.ready).resolves.toBeUndefined();
    await expect(subscriber.ready).resolves.toBeUndefined();
    session.destroy();
    subscriber.destroy();
  });

  it('offers tracks with PUBLISH and reports acceptance', async () => {
    const results: { trackName: string; accepted: boolean }[] = [];
    const { session, subscriber, publishes } = makePublishHarness({
      onPublishResult: (result) => results.push({ trackName: result.trackName, accepted: result.accepted }),
    });
    await session.ready;

    const video = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    const audio = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'audio' });
    expect(video.trackAlias).not.toBe(audio.trackAlias);

    await vi.waitFor(() => {
      expect(results).toEqual([
        { trackName: 'video', accepted: true },
        { trackName: 'audio', accepted: true },
      ]);
    });
    expect(publishes.map((p) => p.trackName)).toEqual(['video', 'audio']);
    session.destroy();
    subscriber.destroy();
  });

  it('treats PUBLISH_NAMESPACE rejection as advisory (subscribe-only peers reject it)', async () => {
    const namespaceResults: { accepted: boolean; errorCode?: number }[] = [];
    const publishResults: boolean[] = [];
    const { session, subscriber } = makePublishHarness({
      onNamespaceResult: (result) =>
        namespaceResults.push({ accepted: result.accepted, errorCode: result.error?.errorCode }),
      onPublishResult: (result) => publishResults.push(result.accepted),
    });
    await session.ready;

    session.publishNamespace(NAMESPACE);
    await vi.waitFor(() => {
      expect(namespaceResults).toEqual([{ accepted: false, errorCode: REQUEST_ERROR_CODE.NOT_SUPPORTED }]);
    });

    // The session survives — PUBLISH still goes through.
    session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    await vi.waitFor(() => {
      expect(publishResults).toEqual([true]);
    });
    session.destroy();
    subscriber.destroy();
  });

  it('answers inbound SUBSCRIBE for a published track with its alias and routes REQUEST_UPDATE', async () => {
    const subscribes: IncomingSubscribe[] = [];
    const updates: { requestId: number }[] = [];
    const { session, subscriber } = makePublishHarness({
      onSubscribe: (subscribe) => subscribes.push(subscribe),
      onRequestUpdate: (update) => updates.push({ requestId: update.requestId }),
    });
    await session.ready;
    const track = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    let subscribeOkAlias: number | undefined;
    const subscription = subscriber.subscribe(
      { trackNamespace: NAMESPACE, trackName: 'video' },
      {
        onOk: (ok) => {
          subscribeOkAlias = ok.trackAlias;
        },
      }
    );

    await vi.waitFor(() => {
      expect(subscribeOkAlias).toBe(track.trackAlias);
      expect(subscribes.map((s) => s.trackName)).toEqual(['video']);
    });

    subscription.update({ subscriberPriority: 9 });
    await vi.waitFor(() => {
      expect(updates).toEqual([{ requestId: subscription.requestId }]);
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

  it('fails a PUBLISH that gets no response before the request timeout', async () => {
    const pair = createTransportPair();
    // A peer that completes SETUP but never answers requests.
    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();
      await writer.write(encodeSetup([]));
    })();
    const results: { accepted: boolean; errorCode?: number }[] = [];
    const session = createMoqtPublishSession(pair.client, {
      requestTimeoutMs: 50,
      callbacks: {
        onPublishResult: (result) => results.push({ accepted: result.accepted, errorCode: result.error?.errorCode }),
      },
    });
    await session.ready;
    session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    await vi.waitFor(() => {
      expect(results).toEqual([{ accepted: false, errorCode: REQUEST_ERROR_CODE.TIMEOUT }]);
    });
    session.destroy();
  });

  it('ignores a PUBLISH response that arrives after the request timeout', async () => {
    const pair = createTransportPair();
    // A peer that completes SETUP, holds the request stream past the
    // timeout, then answers late.
    let requestStream: Awaited<ReturnType<typeof pair.server.createBidirectionalStream>> | undefined;
    void (async () => {
      const control = await pair.server.createUnidirectionalStream();
      const writer = control.getWriter();
      await writer.write(encodeSetup([]));
      const streams = pair.server.incomingBidirectionalStreams.getReader();
      requestStream = (await streams.read()).value;
    })();
    const results: { accepted: boolean; errorCode?: number }[] = [];
    const session = createMoqtPublishSession(pair.client, {
      requestTimeoutMs: 50,
      callbacks: {
        onPublishResult: (result) => results.push({ accepted: result.accepted, errorCode: result.error?.errorCode }),
      },
    });
    await session.ready;
    session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    await vi.waitFor(() => {
      expect(results).toEqual([{ accepted: false, errorCode: REQUEST_ERROR_CODE.TIMEOUT }]);
      expect(requestStream).toBeDefined();
    });

    // The timeout must have killed the request stream: a late REQUEST_OK
    // fired onPublishResult a second time when it was left open.
    const writer = requestStream!.writable.getWriter();
    await writer.write(encodeRequestOk()).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results).toEqual([{ accepted: false, errorCode: REQUEST_ERROR_CODE.TIMEOUT }]);
    session.destroy();
  });

  it('close() drains PUBLISH_DONE to the wire before closing the transport', async () => {
    const subscribes: IncomingSubscribe[] = [];
    const { session, subscriber } = makePublishHarness({ onSubscribe: (subscribe) => subscribes.push(subscribe) });
    await session.ready;
    await subscriber.ready;
    const track = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    const video = collectTrack(subscriber, 'video');
    await vi.waitFor(() => {
      expect(subscribes).toHaveLength(1);
    });

    // Production shape: the track owner announces done and the session
    // closes in the same tick — no manual settling in between. The DONE
    // control writes land microtasks later; close() must hold the
    // transport open until they do (closing discards queued data).
    track.done(PUBLISH_DONE_STATUS.TRACK_ENDED, 3, 'stopped');
    session.close();

    await vi.waitFor(() => {
      expect(video.done).toMatchObject([
        { statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 3, reason: 'stopped' },
      ]);
    });
    subscriber.destroy();
  });

  it('close() sends a last-resort PUBLISH_DONE for tracks never explicitly done', async () => {
    const subscribes: IncomingSubscribe[] = [];
    const { session, subscriber } = makePublishHarness({ onSubscribe: (subscribe) => subscribes.push(subscribe) });
    await session.ready;
    await subscriber.ready;
    session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    const video = collectTrack(subscriber, 'video');
    await vi.waitFor(() => {
      expect(subscribes).toHaveLength(1);
    });

    session.close();
    await vi.waitFor(() => {
      expect(video.done).toMatchObject([{ statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED }]);
    });
    subscriber.destroy();
  });

  it('close() leaves no request-timeout timer running', async () => {
    vi.useFakeTimers();
    try {
      const pair = createTransportPair();
      // A peer that completes SETUP but never answers requests, so the
      // PUBLISH response timer stays armed.
      void (async () => {
        const control = await pair.server.createUnidirectionalStream();
        const writer = control.getWriter();
        await writer.write(encodeSetup([]));
      })();
      const session = createMoqtPublishSession(pair.client, { requestTimeoutMs: 10_000 });
      await session.ready;
      session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
      // Let the request stream open and arm its response timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      session.close();
      // Room for the close drain's own (self-clearing) timers; well under
      // the 10s response timeout, which must be gone by now.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishTrack() after destroy is inert — no request stream, no track state', async () => {
    const { pair, session, subscriber } = makePublishHarness();
    await session.ready;
    session.destroy();

    const openStreams = vi.spyOn(pair.client, 'createBidirectionalStream');
    const handle = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'late' });
    expect(() => handle.done()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openStreams).not.toHaveBeenCalled();
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

  it('delivers a parseable catalog and LOC frames end to end, with PUBLISH_DONE on stop', async () => {
    const { session, subscriber } = makePublishHarness();
    await session.ready;
    await subscriber.ready;

    session.publishNamespace(NAMESPACE);
    const catalogTrack = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    const videoTrack = session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });

    const catalog = collectTrack(subscriber, 'catalog');
    const video = collectTrack(subscriber, 'video');
    await vi.waitFor(() => {
      expect(catalog.subscription.requestId).toBeDefined();
    });

    // Publish the catalog as object 0 of a group on the catalog track.
    const catalogPublisher = createTrackPublisherActor({
      openUniStream: () => session.openUniStream(),
      trackAlias: catalogTrack.trackAlias,
      groupPerFrame: true,
    });
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

    // Publish two groups of LOC video frames (keyframe → new group).
    const videoPublisher = createTrackPublisherActor({
      openUniStream: () => session.openUniStream(),
      trackAlias: videoTrack.trackAlias,
    });
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

    // The subscriber sees a catalog object whose JSON parse-catalog accepts.
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

    // Unpublish: PUBLISH_DONE lands on the subscribe request streams.
    videoPublisher.destroy();
    catalogPublisher.destroy();
    videoTrack.done(PUBLISH_DONE_STATUS.TRACK_ENDED, 2, 'stopped');
    catalogTrack.done();
    await vi.waitFor(() => {
      expect(video.done).toMatchObject([
        { statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED, streamCount: 2, reason: 'stopped' },
      ]);
      expect(catalog.done).toHaveLength(1);
    });

    session.destroy();
    subscriber.destroy();
  });
});

describe('createPublishSessionActor', () => {
  it('walks connecting → ready → live and tracks subscribers', async () => {
    const pair = createTransportPair();
    const peer = makeSubscriberPeer(pair.server);
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
    const session = actor.snapshot.get().context.session!;
    session.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    await vi.waitFor(() => {
      record();
      expect(actor.snapshot.get().context.status).toBe('live');
    });
    expect(statuses).toEqual(['connecting', 'ready', 'live']);
    expect(actor.snapshot.get().context.publishedTracks).toBe(1);

    peer.session.subscribe({ trackNamespace: NAMESPACE, trackName: 'video' }, {});
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.subscriberCount).toBe(1);
    });

    actor.destroy();
    peer.session.destroy();
  });

  it('moves to failed when a PUBLISH is rejected', async () => {
    const pair = createTransportPair();
    const subscriber = createMoqtSession(pair.server, {
      callbacks: {
        onIncomingPublish: (_publish, respond) => respond.reject(REQUEST_ERROR_CODE.UNINTERESTED, 'no thanks'),
      },
    });
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    actor.snapshot.get().context.session!.publishTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('failed');
    });
    expect(actor.snapshot.get().context.error).toBeInstanceOf(Error);
    actor.destroy();
    subscriber.destroy();
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
  // the connect URL (`composePublishConnectUrl`) until relays support them.
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
    expect(actor.getAuthParameters()).toEqual({});
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
