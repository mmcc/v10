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
 * token), composed onto the connect URL's `?jwt=` query parameter — the
 * only carriage the known relay fleet (moq-lite-rs lineage) accepts; see
 * `composePlaybackConnectUrl`. `getAuthParameters()` always resolves empty
 * — nothing rides a request's parameters. `refreshAuthToken()` always
 * rejects: this actor connects once and never reconnects (a `goaway` is
 * only recorded, see `SessionMessage`'s `'goaway'` case), so a refreshed
 * token has nowhere left to attach — the jwt is fixed at connect time.
 * Both stay on the interface (with `MoqAuthProvider.refreshToken`) for a
 * future relay generation that accepts draft-19 AUTHORIZATION_TOKEN
 * request parameters, at which point a token could ride a request
 * instead of only the connect URL.
 */
import { createTransitionActor, type TransitionActor } from '../../core/actors/create-transition-actor';
import type { MoqSource } from '../../media/moq/parse-source';
import { type MessageParameters, MOQT_PROTOCOL_ID } from '../../network/moqt/control-messages';
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
 * Supplies/refreshes the authorization token *value* for the connection
 * (MSF §11.4). The actor composes it onto the connect URL's `?jwt=` query
 * parameter (`composePlaybackConnectUrl`).
 */
export interface MoqAuthProvider {
  getToken(): Promise<Uint8Array | string | undefined> | Uint8Array | string | undefined;
  /**
   * Unused today: `MoqSessionActor.refreshAuthToken()` rejects before ever
   * calling this — see its doc. A refreshed token has no connection left
   * to attach to (the jwt rides only the connect URL, fixed at connect
   * time), so calling this here would mint a token from the provider that
   * no code could ever use. Kept on the interface for a future relay
   * generation that accepts draft-19 AUTHORIZATION_TOKEN request
   * parameters, at which point a mid-session refresh becomes meaningful.
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
}

export interface MoqSessionActor extends Pick<TransitionActor<MoqSessionActorContext, SessionMessage>, 'snapshot'> {
  /**
   * Request parameters carrying the current auth token — currently always
   * empty; the token rides the connect URL instead (see the module doc).
   */
  getAuthParameters(): MessageParameters;
  /**
   * Always rejects — see the implementation's doc comment for why. Kept
   * on the interface (and called by callers' one-shot EXPIRED_AUTH_TOKEN
   * retries, e.g. `resolve-catalog.ts`/`track-subscriber.ts`) so that
   * retry path gives up cleanly on rejection instead of needing removal
   * now and reinstatement once a future relay generation supports
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
 * Whether resolving an auth token for this URL would be wasted work — the
 * exact complement of the two cases where {@link composePlaybackConnectUrl}
 * discards the token it is handed:
 *
 *   - the URL already carries an explicit `jwt` param, which wins;
 *   - the URL is unparseable, so it goes to WebTransport verbatim.
 *
 * The two must agree. When they disagree, the actor mints a token that is
 * then thrown away — and a *throwing* provider surfaces its own error
 * instead of the canonical `new WebTransport(url)` failure the malformed
 * URL should have produced, which reads as an auth outage rather than the
 * typo it is.
 */
function skipTokenResolution(url: string): boolean {
  try {
    return new URL(url).searchParams.has('jwt');
  } catch {
    return true;
  }
}

/**
 * Compose the WebTransport connect URL for a source. moq-lite-rs lineage
 * relays (Mux's relay-rs fleet, the Varnish lab relays) authenticate with
 * a JWT `?jwt=` query parameter on the connect URL and close the
 * connection right after CLIENT_SETUP when auth is required but missing
 * — the same carriage `composePublishConnectUrl` uses on the publish
 * side (`publish/session/publish-session.ts`), for the same reason: this
 * relay fleet hard-closes the session (`5 "invalid value"`) when a
 * draft-19 AUTHORIZATION_TOKEN structure rides a request's parameters
 * instead. An explicit `jwt` param already in the source URL wins, and
 * an unparseable URL is returned verbatim so `new WebTransport(url)`
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
 * Connect to the source's relay and drive the session lifecycle. The
 * connection starts immediately — composition-level gating (preload /
 * load-activation) belongs to the behavior that creates this actor.
 */
export function createMoqSessionActor(options: CreateMoqSessionActorOptions): MoqSessionActor {
  const { source, authProvider } = options;
  const createTransport = options.createTransport ?? createWebTransport;

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
      // Decoding happens here, inside the try, so a binary (non-UTF-8)
      // token — from the source's `c4m` fragment or the auth provider —
      // throws into the same 'failed' path as any other connect-time
      // error, rather than escaping past this actor's constructor.
      let authToken: string | undefined;
      // Skip token resolution whenever the token would be discarded by
      // `composePlaybackConnectUrl` (see `skipTokenResolution`): minting one
      // would be pointless work, and a provider failure must not block —
      // or mis-report — a connect whose URL was never going to carry it.
      if (!skipTokenResolution(source.connectUrl)) {
        authToken = toTokenString(source.c4mToken);
        if (authProvider) {
          authToken = toTokenString(await authProvider.getToken()) ?? authToken;
          // destroy() during a pending getToken() must not open a connection.
          if (destroyed) return;
        }
      }
      const created = createTransport(composePlaybackConnectUrl(source.connectUrl, authToken), [MOQT_PROTOCOL_ID]);
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
      session?.destroy();
      inner.destroy();
    },
  };
}
