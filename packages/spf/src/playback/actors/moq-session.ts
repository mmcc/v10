/**
 * Actor owning the WebTransport connection + MOQT session for one MoQ source.
 *
 * Wraps the callback-shaped `network/moqt` session driver in a reactive snapshot: behaviors read
 * `snapshot.context.status` for the connection lifecycle (`'connecting' → 'ready'`, terminal `'closed'`/`'failed'`) and
 * `snapshot.context.session` for the live `MoqtSession` once ready. A reducer-shaped `TransitionActor` fits — the
 * interesting state is all context; the finite `value` is just the universal active/destroyed lifecycle marker.
 *
 * **Unexpected session loss reconnects rather than terminating.** A transport drop, relay restart, or failed connect
 * cycles the status through `'reconnecting'` and retries with capped, jittered backoff (`reconnect` config). Each
 * recovered connection is a _new_ `MoqtSession` published on a `'ready'` snapshot — behaviors keyed on `status ===
 * 'ready'` tear their subscriptions down on the drop and re-issue them against the fresh session, which is what rejoins
 * the catalog and media tracks at the live edge. `'failed'` now means the retry budget is spent (or the failure is
 * permanent, like the QUIC mandate below); `'closed'` remains the deliberate local teardown.
 *
 * Also the home of the MSF §11.4 auth seam: `authProvider` supplies the initial authorization token (defaulting to the
 * source's `c4m` fragment token), composed onto the connect URL's `?jwt=` query parameter — the only carriage the known
 * relay fleet (moq-lite-rs lineage) accepts; see `composePlaybackConnectUrl`. `getAuthParameters()` always resolves
 * empty — nothing rides a request's parameters. `refreshAuthToken()` always rejects: this actor connects once and never
 * reconnects (a `goaway` is only recorded, see `SessionMessage`'s `'goaway'` case), so a refreshed token has nowhere
 * left to attach — the jwt is fixed at connect time. Both stay on the interface (with `MoqAuthProvider.refreshToken`)
 * for a future relay generation that accepts draft-19 AUTHORIZATION_TOKEN request parameters, at which point a token
 * could ride a request instead of only the connect URL.
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import type { MoqSource } from '../../media/moq/parse-source';
import { type MessageParameters, MOQT_PROTOCOL_ID } from '../../network/moqt/control-messages';
import { createMoqtSession, type Goaway, type MoqtSession, type MoqtTransport } from '../../network/moqt/session';
import {
  DEFAULT_RECONNECT_BACKOFF_CONFIG,
  type RetryBackoffConfig,
  resolveRetryBackoffConfig,
  retryDelayMs,
} from '../../network/retry-backoff';

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

/** Transport factory seam. A browser passes the `WebTransport`-backed default; tests inject an in-memory fake. */
export type CreateMoqTransport = (
  connectUrl: string,
  protocols: string[]
) => { transport: MoqtTransport; ready: Promise<void> };

/**
 * Supplies/refreshes the authorization token _value_ for the connection (MSF §11.4). The actor composes it onto the
 * connect URL's `?jwt=` query parameter (`composePlaybackConnectUrl`).
 */
export interface MoqAuthProvider {
  getToken(): Promise<Uint8Array | string | undefined> | Uint8Array | string | undefined;
  /**
   * Unused today: `MoqSessionActor.refreshAuthToken()` rejects before ever calling this — see its doc. A refreshed
   * token has no connection left to attach to (the jwt rides only the connect URL, fixed at connect time), so calling
   * this here would mint a token from the provider that no code could ever use. Kept on the interface for a future
   * relay generation that accepts draft-19 AUTHORIZATION_TOKEN request parameters, at which point a mid-session refresh
   * becomes meaningful.
   */
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
   * Reconnect policy for unexpected session loss (transport drop, relay restart, connect failure). Defaults to
   * {@link DEFAULT_RECONNECT_BACKOFF_CONFIG} — retry forever with capped, jittered backoff. `maxAttempts: 0` disables
   * reconnection entirely (the pre-resilience terminal behavior).
   */
  reconnect?: Partial<RetryBackoffConfig>;
}

export interface MoqSessionActor extends Pick<TransitionActor<MoqSessionActorContext, SessionMessage>, 'snapshot'> {
  /**
   * Request parameters carrying the current auth token — currently always empty; the token rides the connect URL
   * instead (see the module doc).
   */
  getAuthParameters(): MessageParameters;
  /**
   * Always rejects — see the implementation's doc comment for why. Kept on the interface (and called by callers'
   * one-shot EXPIRED_AUTH_TOKEN retries, e.g. `resolve-catalog.ts`/`track-subscriber.ts`) so that retry path gives up
   * cleanly on rejection instead of needing removal now and reinstatement once a future relay generation supports
   * mid-session auth refresh.
   */
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

// Fatal, unlike `network/moqt/bytes`' shared `utf8Decode` — that decoder is
// non-fatal because other wire code legitimately tolerates lossy text, and
// must stay that way. A token is different: silently substituting U+FFFD
// for invalid bytes sends a corrupted credential to the relay, which
// closes the session with no signal beyond a generic connect failure.
// Local to this file on purpose.
const fatalTokenDecoder = new TextDecoder('utf-8', { fatal: true });

function toTokenString(token: Uint8Array | string | undefined): string | undefined {
  if (token === undefined) return undefined;

  if (typeof token === 'string') return token;

  try {
    return fatalTokenDecoder.decode(token);
  } catch {
    // A binary token (e.g. a CBOR-encoded CAT token) has nowhere to go:
    // the connect URL's `?jwt=` parameter is the only carriage this actor
    // has (see the module doc), and that parameter is text. Throw loudly
    // instead of shipping a substituted/corrupted value the relay will
    // reject anyway with no useful signal.
    throw new Error(
      'a binary authorization token cannot be carried in the ?jwt= connect-URL parameter — a text (JWT) token is required'
    );
  }
}

/**
 * Whether resolving an auth token for this URL would be wasted work — the exact complement of the two cases where
 * {@link composePlaybackConnectUrl} discards the token it is handed:
 *
 * - The URL already carries an explicit `jwt` param, which wins;
 * - The URL is unparseable, so it goes to WebTransport verbatim.
 *
 * The two must agree. When they disagree, the actor mints a token that is then thrown away — and a _throwing_ provider
 * surfaces its own error instead of the canonical `new WebTransport(url)` failure the malformed URL should have
 * produced, which reads as an auth outage rather than the typo it is.
 */
function skipTokenResolution(url: string): boolean {
  try {
    return new URL(url).searchParams.has('jwt');
  } catch {
    return true;
  }
}

/**
 * Compose the WebTransport connect URL for a source. moq-lite-rs lineage relays (Mux's relay-rs fleet, the Varnish lab
 * relays) authenticate with a JWT `?jwt=` query parameter on the connect URL and close the connection right after
 * CLIENT_SETUP when auth is required but missing — the same carriage `composePublishConnectUrl` uses on the publish
 * side (`publish/session/publish-session.ts`), for the same reason: this relay fleet hard-closes the session (`5
 * "invalid value"`) when a draft-19 AUTHORIZATION_TOKEN structure rides a request's parameters instead. An explicit
 * `jwt` param already in the source URL wins, and an unparseable URL is returned verbatim so `new WebTransport(url)`
 * raises the canonical error.
 */
export function composePlaybackConnectUrl(url: string, authToken?: string): string {
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

/**
 * Connect to the source's relay and drive the session lifecycle. The connection starts immediately — composition-level
 * gating (preload / load-activation) belongs to the behavior that creates this actor.
 */
export function createMoqSessionActor(options: CreateMoqSessionActorOptions): MoqSessionActor {
  const { source, authProvider } = options;
  const createTransport = options.createTransport ?? createWebTransport;

  let destroyed = false;
  let session: MoqtSession | undefined;
  /**
   * The transport of a connect attempt still in flight — the handshake has not settled, so no session owns it yet.
   * destroy() closes it directly: waiting on `created.ready` to settle would leave a hung handshake's connection open
   * indefinitely.
   */
  let pendingTransport: MoqtTransport | undefined;

  const reconnectConfig = resolveRetryBackoffConfig(DEFAULT_RECONNECT_BACKOFF_CONFIG, options.reconnect);
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
          // The deliberate teardown destroyed the session — a retained
          // observer must not find a callable handle on a closed snapshot.
          return { ...context, status: 'closed', session: undefined };
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
      let authToken: string | undefined;

      // Skip token resolution whenever the token would be discarded by
      // `composePlaybackConnectUrl` (see `skipTokenResolution`): minting one
      // would be pointless work, and a provider failure must not block —
      // or mis-report — a connect whose URL was never going to carry it.
      if (!skipTokenResolution(source.connectUrl)) {
        let providerToken: Uint8Array | string | undefined;

        if (authProvider) {
          providerToken = await authProvider.getToken();

          // destroy() during a pending getToken() must not open a connection.
          if (destroyed) return;
        }

        try {
          // Decoded inside start() so a binary (non-UTF-8) token — from
          // the source's `c4m` fragment or the auth provider — lands as a
          // snapshot failure rather than escaping this actor's
          // constructor. Its own try, and terminal: the same bytes decode
          // the same way on every attempt, so the reconnect path the outer
          // catch takes for *transient* failures would loop on a config
          // error forever.
          const c4mToken = toTokenString(source.c4mToken);

          authToken = toTokenString(providerToken) ?? c4mToken;
        } catch (error) {
          inner.send({ type: 'failed', error });
          return;
        }
      }

      const created = createTransport(composePlaybackConnectUrl(source.connectUrl, authToken), [MOQT_PROTOCOL_ID]);

      transport = created.transport;
      pendingTransport = transport;
      await created.ready;
      pendingTransport = undefined;

      // No close here: a destroy() that ran while the handshake was in
      // flight already closed the pending transport, and a second close
      // may throw on custom MoqtTransport implementations.
      if (destroyed) return;

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
      pendingTransport = undefined;

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
   * How long a connection must stay ready before a later drop counts as a _new_ outage (resetting the backoff) rather
   * than a continuation of the last one. Keeps a connect-then-immediately-drop flap escalating toward the backoff
   * ceiling instead of hammering the relay at the initial delay.
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

  // The token rides ONLY in the connect URL's `?jwt=` query parameter
  // (`composePlaybackConnectUrl`). The known relay fleet (moq-lite-rs
  // lineage, incl. Mux's relay-rs deployments) does not support draft-19
  // AUTHORIZATION_TOKEN structures yet and hard-closes the session
  // (`5 "invalid value"`) when one appears in a request's parameters —
  // the same defect fixed on the publish side in `publish-session.ts`.
  // Re-attach via this seam (encodeAuthTokenUseValue, §10.2.2) once
  // relays accept draft-19 auth.
  const tokenParameters = (): MessageParameters => ({});

  return {
    get snapshot() {
      return inner.snapshot;
    },

    getAuthParameters: tokenParameters,

    async refreshAuthToken(): Promise<MessageParameters> {
      // Always rejects, without calling `authProvider.refreshToken()`.
      // The token rides ONLY the connect URL (`composePlaybackConnectUrl`),
      // fixed at connect time, and this actor never reconnects (a goaway
      // is only recorded — see the module doc) — so a freshly minted token
      // would have no connection left to attach to. Calling the provider
      // anyway would cost a real round-trip (and, for a provider backed by
      // a minting service, a real token) for a value guaranteed to go
      // unused. Callers' one-shot EXPIRED_AUTH_TOKEN retries
      // (resolve-catalog.ts, track-subscriber.ts) already treat rejection
      // here as "give up cleanly."
      throw new Error(
        'cannot refresh the MoQ auth token: the token rides only the connect URL, fixed at connect time, and this actor does not reconnect — a fresh token has nothing to attach to'
      );
    },

    destroy(): void {
      if (destroyed) return;

      destroyed = true;

      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      try {
        pendingTransport?.close();
      } catch {
        // an already-failed transport throws on close()
      }

      pendingTransport = undefined;
      session?.destroy();
      // Published explicitly: the session's own onClosed callback bails on
      // `destroyed`, so this is the only place the deliberate-teardown
      // status can come from now that unexpected closes reconnect instead.
      inner.send({ type: 'closed' });
      inner.destroy();
    },
  };
}
