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
 * **Unexpected session loss reconnects rather than terminating.** A
 * transport drop, relay restart, or failed connect cycles the status
 * through `'reconnecting'` and retries with capped, jittered backoff
 * (`reconnect` config). Each recovered connection is a *new*
 * `MoqtSession` published on a `'ready'` snapshot — behaviors keyed on
 * `status === 'ready'` tear their subscriptions down on the drop and
 * re-issue them against the fresh session, which is what rejoins the
 * catalog and media tracks at the live edge. `'failed'` now means the
 * retry budget is spent (or the failure is permanent, like the QUIC
 * mandate below); `'closed'` remains the deliberate local teardown.
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
import { DEFAULT_RECONNECT_BACKOFF_CONFIG, type RetryBackoffConfig, retryDelayMs } from '../../network/retry-backoff';

// =============================================================================
// Types
// =============================================================================

export type MoqSessionStatus = 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'failed';

export interface MoqSessionActorContext {
  status: MoqSessionStatus;
  /** Present while `'ready'`; cleared when the session drops. */
  session?: MoqtSession;
  /** Set when the server announced migration; requests should re-issue elsewhere. */
  goaway?: Goaway;
  error?: unknown;
}

type SessionMessage =
  | { type: 'connected'; session: MoqtSession }
  | { type: 'goaway'; goaway: Goaway }
  | { type: 'reconnecting'; error?: unknown }
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
  /**
   * Reconnect policy for unexpected session loss (transport drop, relay
   * restart, connect failure). Defaults to
   * {@link DEFAULT_RECONNECT_BACKOFF_CONFIG} — retry forever with capped,
   * jittered backoff. `maxAttempts: 0` disables reconnection entirely
   * (the pre-resilience terminal behavior).
   */
  reconnect?: Partial<RetryBackoffConfig>;
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

  const reconnectConfig: RetryBackoffConfig = { ...DEFAULT_RECONNECT_BACKOFF_CONFIG, ...options.reconnect };
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let readySinceMs: number | undefined;

  const inner = createTransitionActor<MoqSessionActorContext, SessionMessage>(
    { status: 'connecting' },
    (context, message) => {
      // Terminal states are sticky: a transport-closed callback after a
      // failure must not soften 'failed' back to 'closed'.
      if (context.status === 'closed' || context.status === 'failed') return context;
      switch (message.type) {
        case 'connected':
          // A fresh context, not a merge: a GOAWAY or error left behind by
          // a previous connection describes nothing about this one.
          return { status: 'ready', session: message.session };
        case 'goaway':
          return { ...context, goaway: message.goaway };
        case 'reconnecting':
          // The dead session leaves the context so no consumer can issue
          // requests against it while the retry timer runs.
          return { status: 'reconnecting', error: message.error };
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
    let attemptSession: MoqtSession | undefined;
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
      attemptSession = createMoqtSession(transport, {
        unknownAliasTimeoutMs: options.unknownAliasTimeoutMs,
        callbacks: {
          onGoaway: (goaway) => inner.send({ type: 'goaway', goaway }),
          // Any close the actor did not initiate — transport drop, relay
          // restart, protocol failure — is an outage to recover from, not
          // a terminal state. destroy() sets `destroyed` before closing
          // the session, so a deliberate teardown never lands here.
          onClosed: ({ error }) => scheduleReconnect(error),
        },
      });
      session = attemptSession;
      await attemptSession.ready;
      // The transport can drop in the gap between `ready` resolving and
      // this continuation running. `scheduleReconnect` has then already
      // published 'reconnecting' and cleared `session` — a late
      // 'connected' here would advertise a ready state whose session is
      // already gone, and downstream behaviors treat 'ready' as a
      // guarantee that a session exists.
      if (destroyed || session !== attemptSession) return;
      readySinceMs = performance.now();
      inner.send({ type: 'connected', session: attemptSession });
    } catch (error) {
      // A transport opened before the failure must not leak the relay
      // connection — a rejected `ready` does not close it on its own.
      // The per-attempt handle, not the shared `session`: a reconnect
      // scheduled mid-attempt clears the shared slot, and the attempt's
      // own session still has to be torn down.
      if (attemptSession) {
        attemptSession.destroy();
      } else {
        try {
          transport?.close();
        } catch {
          // an already-failed transport throws on close()
        }
      }
      if (!destroyed) scheduleReconnect(error);
    }
  };

  /**
   * How long a connection must stay ready before a later drop counts as a
   * *new* outage (resetting the backoff) rather than a continuation of the
   * last one. Keeps a connect-then-immediately-drop flap escalating toward
   * the backoff ceiling instead of hammering the relay at the initial delay.
   */
  const STABLE_CONNECTION_RESET_MS = 30_000;

  const scheduleReconnect = (error: unknown): void => {
    // One recovery per outage: the session driver and the start() catch can
    // both report the same death (a session destroyed mid-connect fires its
    // onClosed synchronously), and a stray late callback after the retry
    // budget is spent must not revive a terminal actor.
    if (destroyed || reconnectTimer !== undefined) return;
    const status = inner.snapshot.get().context.status;
    if (status === 'closed' || status === 'failed') return;
    if (readySinceMs !== undefined && performance.now() - readySinceMs >= STABLE_CONNECTION_RESET_MS) {
      reconnectAttempts = 0;
    }
    readySinceMs = undefined;
    session = undefined;
    const delay = retryDelayMs(reconnectAttempts, reconnectConfig);
    if (delay === undefined) {
      inner.send({ type: 'failed', error: error ?? new Error('MoQ session closed and the reconnect budget is spent') });
      return;
    }
    reconnectAttempts++;
    inner.send({ type: 'reconnecting', error });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void start();
    }, delay);
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
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      session?.destroy();
      // Published explicitly: the session's own onClosed callback bails on
      // `destroyed`, so this is the only place the deliberate-teardown
      // status can come from now that unexpected closes reconnect instead.
      inner.send({ type: 'closed' });
      inner.destroy();
    },
  };
}
