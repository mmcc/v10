/**
 * Actor owning the WebTransport connection + MOQT session for one MoQ
 * source.
 *
 * Wraps the callback-shaped `network/moqt` session driver in a reactive
 * snapshot: behaviors read `snapshot.context.status` for the connection
 * lifecycle (`'connecting' → 'ready'`, terminal `'closed'`/`'failed'`)
 * and `snapshot.context.session` for the live `MoqtSession` once ready.
 * A reducer-shaped `TransitionActor` fits — the interesting state is all
 * context; the finite `value` is just the universal active/destroyed
 * lifecycle marker.
 *
 * Also the home of the MSF §11.4 auth seam: `authProvider` supplies the
 * initial authorization token (defaulting to the source's `c4m` fragment
 * token) and refreshes it when a request fails with EXPIRED_AUTH_TOKEN —
 * subscribers call `getAuthParameters()` when building requests and
 * `refreshAuthToken()` before an auth-expiry retry.
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import type { MoqSource } from '../../media/moq/parse-source';
import { utf8Encode } from '../../network/moqt/bytes';
import { encodeAuthTokenUseValue, type MessageParameters, MOQT_PROTOCOL_ID } from '../../network/moqt/control-messages';
import { createMoqtSession, type Goaway, type MoqtSession, type MoqtTransport } from '../../network/moqt/session';

// =============================================================================
// Types
// =============================================================================

export type MoqSessionStatus = 'connecting' | 'ready' | 'closed' | 'failed';

export interface MoqSessionActorContext {
  status: MoqSessionStatus;
  /** Present from `'ready'` on. */
  session?: MoqtSession;
  /** Set when the server announced migration; requests should re-issue elsewhere. */
  goaway?: Goaway;
  error?: unknown;
}

type SessionMessage =
  | { type: 'connected'; session: MoqtSession }
  | { type: 'goaway'; goaway: Goaway }
  | { type: 'closed' }
  | { type: 'failed'; error: unknown };

/**
 * Transport factory seam. A browser passes the `WebTransport`-backed
 * default; tests inject an in-memory fake.
 */
export type CreateMoqTransport = (
  connectUrl: string,
  protocols: string[]
) => { transport: MoqtTransport; ready: Promise<void> };

/**
 * Supplies/refreshes the authorization token *value* attached to requests
 * (MSF §11.4). The actor serializes it into a MOQT Token structure with
 * Alias Type USE_VALUE.
 */
export interface MoqAuthProvider {
  getToken(): Promise<Uint8Array | string | undefined> | Uint8Array | string | undefined;
  /** Called on auth-expiry; return a fresh token (or nothing to give up). */
  refreshToken?(): Promise<Uint8Array | string | undefined> | Uint8Array | string | undefined;
  /** MOQT auth Token Type codepoint. Default 0. */
  tokenType?: number;
}

export interface CreateMoqSessionActorOptions {
  source: MoqSource;
  createTransport?: CreateMoqTransport;
  authProvider?: MoqAuthProvider;
  /** Forwarded to the session driver (alias buffering timeout, etc.). */
  unknownAliasTimeoutMs?: number;
}

export interface MoqSessionActor extends Pick<TransitionActor<MoqSessionActorContext, SessionMessage>, 'snapshot'> {
  /** Request parameters carrying the current auth token, when one exists. */
  getAuthParameters(): MessageParameters;
  /** Fetch a fresh token from the provider; resolves to the new parameters. */
  refreshAuthToken(): Promise<MessageParameters>;
  destroy(): void;
}

// =============================================================================
// Implementation
// =============================================================================

function createWebTransport(
  connectUrl: string,
  protocols: string[]
): { transport: MoqtTransport; ready: Promise<void> } {
  const transport = new WebTransport(connectUrl, { protocols });
  return { transport, ready: transport.ready.then(() => undefined) };
}

function toTokenBytes(token: Uint8Array | string | undefined): Uint8Array | undefined {
  if (token === undefined) return undefined;
  return typeof token === 'string' ? utf8Encode(token) : token;
}

/**
 * Connect to the source's relay and drive the session lifecycle. The
 * connection starts immediately — composition-level gating (preload /
 * load-activation) belongs to the behavior that creates this actor.
 */
export function createMoqSessionActor(options: CreateMoqSessionActorOptions): MoqSessionActor {
  const { source, authProvider } = options;
  const createTransport = options.createTransport ?? createWebTransport;

  let authToken = toTokenBytes(source.c4mToken);
  let destroyed = false;
  let session: MoqtSession | undefined;

  const inner = createTransitionActor<MoqSessionActorContext, SessionMessage>(
    { status: 'connecting' },
    (context, message) => {
      // Terminal states are sticky: a transport-closed callback after a
      // failure must not soften 'failed' back to 'closed'.
      if (context.status === 'closed' || context.status === 'failed') return context;
      switch (message.type) {
        case 'connected':
          return { ...context, status: 'ready', session: message.session };
        case 'goaway':
          return { ...context, goaway: message.goaway };
        case 'closed':
          return { ...context, status: 'closed' };
        case 'failed':
          return { ...context, status: 'failed', error: message.error };
      }
    }
  );

  const start = async () => {
    // MSF `connection=q` mandates native QUIC (§11.1.1 "MUST be used"),
    // which the WebTransport default cannot provide. Only a host-supplied
    // transport factory (e.g. a non-browser runtime with a QUIC stack) can
    // honor the mandate — without one, connecting would silently violate it.
    if (source.connection === 'quic' && !options.createTransport) {
      inner.send({
        type: 'failed',
        error: new Error(
          'MSF source mandates a native QUIC connection (connection=q), but no QUIC-capable transport factory was provided'
        ),
      });
      return;
    }
    let transport: MoqtTransport | undefined;
    try {
      if (authProvider) {
        authToken = toTokenBytes(await authProvider.getToken()) ?? authToken;
        // destroy() during a pending getToken() must not open a connection.
        if (destroyed) return;
      }
      const created = createTransport(source.connectUrl, [MOQT_PROTOCOL_ID]);
      transport = created.transport;
      await created.ready;
      if (destroyed) {
        transport.close();
        return;
      }
      session = createMoqtSession(transport, {
        unknownAliasTimeoutMs: options.unknownAliasTimeoutMs,
        callbacks: {
          onGoaway: (goaway) => inner.send({ type: 'goaway', goaway }),
          onClosed: ({ error }) => {
            inner.send(error === undefined ? { type: 'closed' } : { type: 'failed', error });
          },
        },
      });
      await session.ready;
      if (destroyed) return;
      inner.send({ type: 'connected', session });
    } catch (error) {
      // A transport opened before the failure must not leak the relay
      // connection — a rejected `ready` does not close it on its own.
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

  const tokenParameters = (): MessageParameters => {
    if (!authToken) return {};
    return { authorizationTokens: [encodeAuthTokenUseValue(authProvider?.tokenType ?? 0, authToken)] };
  };

  return {
    get snapshot() {
      return inner.snapshot;
    },

    getAuthParameters: tokenParameters,

    async refreshAuthToken(): Promise<MessageParameters> {
      // No refreshed token means the provider gave up (or there is no
      // provider) — resolving with the stale parameters would trigger a
      // pointless second unauthorized request, so surface the give-up.
      const refreshed = toTokenBytes(await authProvider?.refreshToken?.());
      if (!refreshed) {
        throw new Error('MoQ auth provider could not supply a fresh token');
      }
      authToken = refreshed;
      return tokenParameters();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      session?.destroy();
      inner.destroy();
    },
  };
}
