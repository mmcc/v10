import { createMoqtSession, type MoqtObject, type MoqtSession, SETUP_OPTION, utf8Decode } from '@caprid/moq-core';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { toLocFrame } from '../../../media/moq/loc';
import { packageLocFrame } from '../../../media/moq/loc-packaging';
import { applyMoqCatalogUpdate } from '../../../media/moq/parse-catalog';
import {
  ControlMessageDeframer,
  decodeControlMessage,
  encodeGoaway,
  encodeSetup,
  utf8Encode,
} from '../../../network/tests/helpers/moqt-wire';
import { solicitNamespace } from '../../../network/tests/helpers/raw-peer';
import {
  createTransportPair,
  SERVER_REQUEST_ID_OFFSET,
  withServerRequestIds,
} from '../../../network/tests/helpers/transport-pair';
import { createTrackPublisherActor } from '../../actors/track-publisher';
import {
  composePublishConnectUrl,
  createPublishSessionActor,
  type PublishSessionActorStatus,
} from '../publish-session';

const NAMESPACE = ['live', 'abc123'];

function collectTrack(
  subscriber: MoqtSession,
  trackName: string
): { objects: MoqtObject[]; subscription: ReturnType<MoqtSession['subscribe']> } {
  const objects: MoqtObject[] = [];
  const subscription = subscriber.subscribe(
    { trackNamespace: NAMESPACE, trackName },
    { onObject: (object) => objects.push(object) }
  );

  return { objects, subscription };
}

describe('createPublishSessionActor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers moqt-22 first with a moqt-20 fallback on the default WebTransport connect', async () => {
    const constructed: { url: string; protocols: string[] }[] = [];

    class FakeWebTransport {
      readonly ready = Promise.reject(new Error('no relay in tests'));
      readonly closed = new Promise(() => {});

      constructor(url: string, options: { protocols: string[] }) {
        constructed.push({ url, protocols: options.protocols });
        this.ready.catch(() => {});
      }

      // On the prototype, where the connect looks for negotiation support.
      get protocol(): string {
        return 'moqt-22';
      }

      close(): void {}
    }

    vi.stubGlobal('WebTransport', FakeWebTransport);

    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/', namespace: NAMESPACE, authToken: 'tok' },
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('failed');
    });
    expect(constructed).toEqual([{ url: 'https://relay.example.com/?jwt=tok', protocols: ['moqt-22', 'moqt-20'] }]);
    actor.destroy();
  });

  it('delivers a parseable catalog and LOC frames end to end over solicited subscriptions', async () => {
    const pair = createTransportPair();
    const subscriber = createMoqtSession(withServerRequestIds(pair.server), { unknownAliasTimeoutMs: 500 });
    const actor = createPublishSessionActor({
      endpoint: { url: 'https://relay.example.com/moq', namespace: NAMESPACE },
      connectTransport: () => ({ transport: pair.client, ready: Promise.resolve() }),
    });

    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('ready');
    });
    await subscriber.ready;

    const session = actor.snapshot.get().context.session!;

    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'catalog' });
    session.registerTrack({ trackNamespace: NAMESPACE, trackName: 'video' });
    void solicitNamespace(pair.server, []);
    await vi.waitFor(() => {
      expect(actor.snapshot.get().context.status).toBe('live');
    });

    // Publishers start unbound — nothing may hit the wire until the peer
    // subscribes and the binding lands (the behavior layer's job; the
    // test wires it directly).
    const catalogPublisher = createTrackPublisherActor({
      openUniStream: (trackAlias) => session.openUniStream(trackAlias),
      groupPerFrame: true,
      replayLastGroupOnBind: true,
    });
    const videoPublisher = createTrackPublisherActor({
      openUniStream: (trackAlias) => session.openUniStream(trackAlias),
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
    const bindings = () => actor.snapshot.get().context.trackBindings;

    await vi.waitFor(() => {
      expect(bindings().catalog).toBeDefined();
      expect(bindings().video).toBeDefined();
    });
    catalogPublisher.send({ type: 'bind', trackAlias: bindings().catalog! });
    videoPublisher.send({ type: 'bind', trackAlias: bindings().video! });

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
    actor.destroy();
    subscriber.destroy();
  });

  it('walks connecting → ready → live on the announce and tracks subscribers and bindings', async () => {
    const pair = createTransportPair();
    const subscriber = createMoqtSession(withServerRequestIds(pair.server), {});
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
      expect(actor.snapshot.get().context.trackBindings).toEqual({
        video: subscription.requestId + SERVER_REQUEST_ID_OFFSET,
      });
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
