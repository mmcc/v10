/**
 * Publish session actor: connects to a relay and drives `@caprid/moq-core`'s publish session (moq-transport draft-22,
 * draft-20 as a fallback) through its lifecycle, exposing a reactive snapshot for the `publish/` behaviors.
 *
 * The protocol mechanics — SETUP, the announce-and-serve ingest flow, SUBSCRIBE_OK with LARGEST_OBJECT and the declared
 * track properties, fills, and PUBLISH_DONE with the session's own Stream Count — live in the package. Its session is
 * callback-shaped with no signals; signal awareness enters here.
 */
import {
  createMoqtPublishSession,
  type Goaway,
  MOQT_PROTOCOL_ID,
  MOQT_PROTOCOL_IDS,
  MoqtProtocolError,
  type MoqtPublishSession,
  type MoqtTransport,
} from '@caprid/moq-core';

import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';

const DEFAULT_IMPLEMENTATION_NAME = '@videojs/spf moqt publisher';

/** Where to publish: a MoQ relay endpoint plus the track namespace. */
export interface PublishEndpoint {
  url: string;
  namespace: string[];
  /**
   * Relay auth token, sent as a `?jwt=` query parameter on the connect URL — the only carriage the known relay fleet
   * (moq-lite-rs lineage) accepts. The announce-and-serve flow attaches no request parameters anywhere (NAMESPACE
   * entries are parameterless by wire rule), so the connect URL is the token's one and only ride.
   */
  authToken?: string;
}

/**
 * Transport factory seam. The default constructs a real `WebTransport` (mirroring the playback session actor's
 * connect); tests and non-browser hosts inject an in-memory or QUIC-backed transport.
 */
export type ConnectPublishTransport = (endpoint: PublishEndpoint) => {
  transport: MoqtTransport;
  ready: Promise<void>;
};

export type PublishSessionActorStatus = 'connecting' | 'ready' | 'live' | 'draining' | 'closed' | 'failed';

export interface PublishSessionActorContext {
  status: PublishSessionActorStatus;
  /** Present from `'ready'` on. */
  session?: MoqtPublishSession;
  /** Set when the server announced migration. */
  goaway?: Goaway;
  error?: unknown;
  /** Live inbound subscriptions across the registered tracks. */
  subscriberCount: number;
  /**
   * Effective per-track alias bindings (`trackName` → alias). A track with no live subscription maps to `undefined` —
   * its publisher must not open data streams.
   */
  trackBindings: Readonly<Record<string, number | undefined>>;
}

type SessionMessage =
  | { type: 'connected'; session: MoqtPublishSession }
  | { type: 'announced' }
  | { type: 'announce-ended'; error: unknown }
  | { type: 'subscribed' }
  | { type: 'unsubscribed' }
  | { type: 'track-binding'; trackName: string; trackAlias: number | undefined }
  | { type: 'goaway'; goaway: Goaway }
  | { type: 'closed' }
  | { type: 'failed'; error: unknown };

export interface CreatePublishSessionActorOptions {
  endpoint: PublishEndpoint;
  connectTransport?: ConnectPublishTransport;
  implementationName?: string;
}

export interface PublishSessionActor extends Pick<
  TransitionActor<PublishSessionActorContext, SessionMessage>,
  'snapshot'
> {
  destroy(): void;
}

/**
 * Compose the WebTransport connect URL for an endpoint. moq-lite-rs lineage relays (Mux's relay-rs fleet, the Varnish
 * lab relays) authenticate with a JWT `?jwt=` query parameter on the connect URL and close the connection right after
 * CLIENT_SETUP when auth is required but missing. An explicit `jwt` param already in the endpoint URL wins, and an
 * unparseable URL is returned verbatim so `new WebTransport(url)` raises the canonical error.
 */
export function composePublishConnectUrl(url: string, authToken?: string): string {
  if (!authToken) return url;

  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('jwt')) return url;

    parsed.searchParams.set('jwt', authToken);
    return parsed.href;
  } catch {
    return url;
  }
}

function connectWebTransport(endpoint: PublishEndpoint): { transport: MoqtTransport; ready: Promise<void> } {
  // The session reads the negotiated version from `transport.protocol` (the
  // `WT-Protocol` response). A browser without that attribute cannot say
  // which version the relay picked, so it offers only the default one.
  const protocols = 'protocol' in WebTransport.prototype ? [...MOQT_PROTOCOL_IDS] : [MOQT_PROTOCOL_ID];
  const transport: WebTransport & MoqtTransport = new WebTransport(
    composePublishConnectUrl(endpoint.url, endpoint.authToken),
    { protocols }
  );

  return { transport, ready: transport.ready.then(() => undefined) };
}

/**
 * Connect to the endpoint's relay and drive the publish-session lifecycle: `'connecting'` → `'ready'` (SETUP complete)
 * → `'live'` (namespace announced on an accepted solicitation — the peer can route SUBSCRIBEs to us; with pull-through
 * peers no data flows until a downstream subscriber asks, so liveness must not wait on `subscriberCount`). A peer that
 * never solicits the namespace leaves the session `'ready'`; losing the announce afterwards is `'failed'` — the ingest
 * path is gone and nothing reconnects automatically. GOAWAY moves a live session to `'draining'`; `destroy()` FINs
 * every live subscription, retracts the announce, lets those writes drain briefly, then closes the transport (the
 * driver's `close()` contract). The connection starts immediately — composition-level gating belongs to the behavior
 * that creates this actor (`open-publish-session`).
 */
export function createPublishSessionActor(options: CreatePublishSessionActorOptions): PublishSessionActor {
  const { endpoint } = options;
  const connectTransport = options.connectTransport ?? connectWebTransport;

  let destroyed = false;
  let session: MoqtPublishSession | undefined;

  const inner = createTransitionActor<PublishSessionActorContext, SessionMessage>(
    { status: 'connecting', subscriberCount: 0, trackBindings: {} },
    (context, message) => {
      // Terminal states are sticky: a transport-closed callback after a
      // failure must not soften 'failed' back to 'closed'.
      if (context.status === 'closed' || context.status === 'failed') return context;

      switch (message.type) {
        case 'connected':
          return { ...context, status: 'ready', session: message.session };
        case 'announced':
          return { ...context, status: context.status === 'ready' ? 'live' : context.status };
        case 'announce-ended':
          return { ...context, status: 'failed', error: message.error };
        case 'subscribed':
          return { ...context, subscriberCount: context.subscriberCount + 1 };
        case 'unsubscribed':
          return { ...context, subscriberCount: Math.max(0, context.subscriberCount - 1) };
        case 'track-binding':
          return {
            ...context,
            trackBindings: { ...context.trackBindings, [message.trackName]: message.trackAlias },
          };
        case 'goaway':
          return { ...context, status: 'draining', goaway: message.goaway };
        case 'closed':
          return { ...context, status: 'closed' };
        case 'failed':
          return { ...context, status: 'failed', error: message.error };
      }
    }
  );

  const start = async () => {
    let transport: MoqtTransport | undefined;

    try {
      const created = connectTransport(endpoint);

      transport = created.transport;
      await created.ready;

      if (destroyed) {
        transport.close();
        return;
      }

      session = createMoqtPublishSession(transport, {
        implementationName: options.implementationName ?? DEFAULT_IMPLEMENTATION_NAME,
        callbacks: {
          onGoaway: (goaway) => inner.send({ type: 'goaway', goaway }),
          onAnnounced: () => inner.send({ type: 'announced' }),
          onAnnounceEnded: ({ error }) =>
            inner.send({
              type: 'announce-ended',
              error: error ?? new MoqtProtocolError('the peer ended the namespace announce'),
            }),
          onSubscribe: () => inner.send({ type: 'subscribed' }),
          onSubscribeEnd: () => inner.send({ type: 'unsubscribed' }),
          onTrackBinding: ({ trackName, trackAlias }) => inner.send({ type: 'track-binding', trackName, trackAlias }),
          onClosed: ({ error }) => {
            inner.send(error === undefined ? { type: 'closed' } : { type: 'failed', error });
          },
        },
      });
      await session.ready;

      if (destroyed) return;

      // The relay solicits authorized namespaces right after SETUP; this
      // registers the desire so the driver answers whichever side of the
      // race arrives second — and the driver additionally defers the
      // wire write until `setupTrackPublishers` registers the first
      // track, so the announce never advertises an empty registry.
      session.announce(endpoint.namespace);
      inner.send({ type: 'connected', session });
    } catch (error) {
      if (session) {
        session.destroy();
      } else {
        try {
          transport?.close();
        } catch {
          // an already-failed transport throws on close()
        }
      }

      if (!destroyed) inner.send({ type: 'failed', error });
    }
  };

  void start();

  return {
    get snapshot() {
      return inner.snapshot;
    },

    destroy(): void {
      if (destroyed) return;

      destroyed = true;
      session?.destroy();
      inner.destroy();
    },
  };
}
