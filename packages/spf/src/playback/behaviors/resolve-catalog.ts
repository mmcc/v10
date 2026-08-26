/**
 * **Resolve a MoQ presentation from its MSF catalog track.** The MoQ analog of `resolve-presentation`: when the session
 * is ready, subscribes to the source's catalog track — per msf-01 §5, SUBSCRIBE plus a joining FETCH (offset 0) to
 * obtain the latest complete catalog and every subsequent update — parses catalog objects (independent and delta), and
 * writes the projected `Presentation` to `state.presentation`.
 *
 *     'preconditions-unmet' → 'awaiting-session' → 'catalog-active'
 *
 * Unlike `resolvePresentation`'s fetch-once `'resolving' → 'resolved'`, the positive state here spans resolution _and_
 * live updates: the catalog subscription stays open, and every new catalog object re-parses and re-writes
 * `state.presentation` (delta re-parse). Stable track ids (`parse-catalog`) keep unchanged track lists from re-firing
 * selection.
 *
 * Ordering: live delta objects can arrive while the joining fetch is still replaying the current group, so live objects
 * buffer until the fetch settles, then apply in (group, object) order. A delta that lands with no prior catalog (fetch
 * unavailable, e.g. nothing published) is dropped — the next independent object (object 0 of a group) recovers.
 *
 * Auth-expiry retry (MSF §11.4): an EXPIRED_AUTH_TOKEN subscribe error refreshes the token via the session actor and
 * recreates the catalog subscription + joining fetch once — same pattern as `track-subscriber`.
 *
 * Failure recovery: a _transient_ subscribe error retries with capped backoff (`subscribeRetry` config, honoring a
 * server-stated Retry Interval) — the common case is DOES_NOT_EXIST because play was pressed before the broadcast
 * started — and a retryable PUBLISH_DONE (broadcaster ended or dropped) re-subscribes the same way. Permanent
 * rejections and auth-shaped ends stop instead of looping (`isRetryableRequestErrorCode` /
 * `isRetryablePublishDoneStatus`). Every recovery restart resets the local catalog base, so a delta from a restarted
 * publisher can never apply against the pre-outage catalog.
 *
 * Multi-writer on `state.presentation` with the engine adapter (initial `{ url }` input) — same legitimate split as
 * `resolvePresentation`.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import {
  applyMoqCatalogUpdate,
  type MoqCatalog,
  type MoqCatalogUpdateOptions,
  moqCatalogToPresentation,
} from '../../media/moq/parse-catalog';
import { isMoqSourceUrl, parseMoqSource } from '../../media/moq/parse-source';
import type { MaybeResolvedPresentation } from '../../media/types';
import { utf8Decode } from '../../network/moqt/bytes';
import type { MessageParameters } from '../../network/moqt/control-messages';
import {
  isRetryablePublishDoneStatus,
  isRetryableRequestErrorCode,
  REQUEST_ERROR_CODE,
} from '../../network/moqt/control-messages';
import type { FetchHandle, Subscription } from '../../network/moqt/session';
import {
  DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG,
  MAX_SERVER_RETRY_INTERVAL_MS,
  type RetryBackoffConfig,
  resolveRetryBackoffConfig,
  retryDelayMs,
} from '../../network/retry-backoff';
import type { MoqSessionActor } from '../actors/moq-session';

export interface ResolveCatalogState {
  presentation?: MaybeResolvedPresentation;
}

export interface ResolveCatalogContext {
  moqSessionActor?: MoqSessionActor;
}

/** Catalog-update parser — pluggable like `parsePresentation`. */
export type ApplyCatalogUpdate = (
  current: MoqCatalog | undefined,
  text: string,
  options: MoqCatalogUpdateOptions
) => MoqCatalog;

export interface ResolveCatalogConfig {
  /** Override MSF catalog parsing (alternate catalog formats/versions). */
  applyCatalogUpdate?: ApplyCatalogUpdate;
  /**
   * Deadline for the joining fetch's replay. The session's request timeout only covers a fetch that never answers — a
   * relay that sends FETCH_OK and then never opens (or never finishes) its data stream would leave `fetchSettled` false
   * forever, buffering live deltas and never resolving a catalog. On expiry the behavior falls back to live-only,
   * exactly as it does for an empty or truncated replay. Default 5000ms.
   */
  catalogFetchTimeoutMs?: number;
  /**
   * Retry policy for a catalog subscription that fails or is ended by the publisher. A failed catalog SUBSCRIBE usually
   * means the track does not exist _yet_ — the viewer pressed play before the broadcast started, or the broadcaster is
   * mid-reconnect — so the retry cadence is also the join latency once it appears. Defaults to
   * {@link DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG}; `maxAttempts: 0` disables retry.
   */
  subscribeRetry?: Partial<RetryBackoffConfig>;
}

const DEFAULT_CATALOG_FETCH_TIMEOUT_MS = 5000;

type ResolveCatalogFsmState = 'preconditions-unmet' | 'awaiting-session' | 'catalog-active';

function setupResolveCatalog({
  state,
  context,
  config,
}: {
  state: {
    presentation: Signal<ResolveCatalogState['presentation']>;
  };
  context: {
    moqSessionActor: ReadonlySignal<ResolveCatalogContext['moqSessionActor']>;
  };
  config?: ResolveCatalogConfig;
}): Reactor<ResolveCatalogFsmState | 'destroying' | 'destroyed'> {
  const applyUpdate = config?.applyCatalogUpdate ?? applyMoqCatalogUpdate;
  const fetchTimeoutMs = config?.catalogFetchTimeoutMs ?? DEFAULT_CATALOG_FETCH_TIMEOUT_MS;
  const retryConfig = resolveRetryBackoffConfig(DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG, config?.subscribeRetry);

  const derivedStateSignal = computed<ResolveCatalogFsmState>(() => {
    const presentation = state.presentation.get();
    if (!presentation?.url || !isMoqSourceUrl(presentation.url)) return 'preconditions-unmet';

    const actor = context.moqSessionActor.get();
    if (!actor || actor.snapshot.get().context.status !== 'ready') return 'awaiting-session';

    return 'catalog-active';
  });

  return createMachineReactor<ResolveCatalogFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      'awaiting-session': {},
      'catalog-active': {
        entry: () => {
          const presentation = state.presentation.get()!;
          const actor = context.moqSessionActor.get()!;
          const session = actor.snapshot.get().context.session!;

          let source: ReturnType<typeof parseMoqSource>;

          try {
            source = parseMoqSource(presentation.url);
          } catch (error) {
            // TODO(error-management): route to a state-error slot once one exists.
            console.error('[resolveCatalog] invalid MSF source URL:', error);
            return;
          }

          const updateOptions: MoqCatalogUpdateOptions = {
            catalogNamespace: source.namespace,
            variables: source.fragmentParams,
          };

          let catalog: MoqCatalog | undefined;
          let fetchSettled = false;
          const bufferedLive: { groupId: number; objectId: number; text: string }[] = [];
          let cancelled = false;
          let authRetried = false;
          let subscription: Subscription | undefined;
          let fetchHandle: FetchHandle | undefined;
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          let retryTimer: ReturnType<typeof setTimeout> | undefined;
          let retryAttempts = 0;
          // Monotonic attempt token: cancelling a subscription/fetch does
          // not stop callbacks already in flight (a cancelled fetch stream
          // can still surface onEnd/onReset), so the auth-expiry retry
          // guards every handler against its superseded attempt — a stale
          // settle or object must not touch the fresh attempt's state.
          let attempt = 0;

          const apply = (text: string, objectId: number): void => {
            // A delta with no prior catalog can't be interpreted (§5.1.6);
            // drop it and recover on the next independent object.
            if (catalog === undefined && objectId > 0) return;

            try {
              catalog = applyUpdate(catalog, text, updateOptions);
              state.presentation.set(moqCatalogToPresentation(catalog, presentation, source.sessionUri));
            } catch (error) {
              // TODO(error-management): route to a state-error slot once one exists.
              console.error('[resolveCatalog] catalog parse failed:', error);
            }
          };

          const settleFetch = (): void => {
            if (fetchSettled) return;

            fetchSettled = true;
            clearTimeout(settleTimer);
            settleTimer = undefined;
            bufferedLive.sort((a, b) => a.groupId - b.groupId || a.objectId - b.objectId);

            for (const { text, objectId } of bufferedLive) apply(text, objectId);

            bufferedLive.length = 0;
          };

          /**
           * Terminal stop: after this, nothing of the current attempt may write `state.presentation` — and no queued
           * restart may reopen the subscription — until the state re-enters. Cancelling the handles alone is neither:
           * the settle timer's callback never checks `isCurrent` and would still drain buffered objects, a cancel can
           * itself surface in-flight onEnd/onReset, and a restart already booked by an earlier retryable report of the
           * same death (an armed retry timer, or an in-flight auth refresh) would start a fresh attempt right over the
           * terminal state. So the attempt token is bumped (invalidating every handler and the refresh restart, which
           * check it), both timers are disarmed, and the buffer discarded before the handles go.
           */
          const stopCatalog = (): void => {
            attempt++;
            clearTimeout(settleTimer);
            settleTimer = undefined;
            clearTimeout(retryTimer);
            retryTimer = undefined;
            bufferedLive.length = 0;
            fetchSettled = true;
            fetchHandle?.cancel();
            subscription?.cancel();
          };

          /**
           * Recover the catalog subscription: after the backoff (raised to a server-stated Retry Interval when one is
           * given), tear the dead attempt down and run `start()` again with fresh auth parameters. Returns false once
           * the retry budget is spent. A restart already scheduled is a no-op success — a PUBLISH_DONE and a stream
           * error reporting the same death book one retry and burn one attempt, not two.
           *
           * The local catalog base resets with the restart. Across a publisher restart the track's (group, object)
           * numbering starts over, and a delta applied against the pre-outage base would silently produce a wrong
           * catalog — dropping deltas until the next independent object (or the new attempt's joining-fetch replay) is
           * the safe recovery §5.1.6 prescribes. `state.presentation` keeps the last resolved value meanwhile, so
           * playback state doesn't flicker.
           */
          const scheduleRestart = (retryIntervalMs = 0): boolean => {
            if (cancelled || retryTimer !== undefined) return true;

            const delay = retryDelayMs(retryAttempts, retryConfig);
            if (delay === undefined) return false;

            retryAttempts++;
            retryTimer = setTimeout(
              () => {
                retryTimer = undefined;

                if (cancelled) return;

                fetchHandle?.cancel();
                subscription?.cancel();
                catalog = undefined;
                start(actor.getAuthParameters());
              },
              Math.max(delay, Math.min(retryIntervalMs, MAX_SERVER_RETRY_INTERVAL_MS))
            );
            return true;
          };

          const start = (parameters: MessageParameters): void => {
            // Fresh attempt: the new joining fetch replays the current
            // group again, so live deltas must buffer until it settles.
            const thisAttempt = ++attempt;
            const isCurrent = (): boolean => attempt === thisAttempt;

            fetchSettled = false;
            bufferedLive.length = 0;
            clearTimeout(settleTimer);
            settleTimer =
              fetchTimeoutMs > 0
                ? setTimeout(() => {
                    // Deadline passed: fall back to live-only and stop the
                    // replay — a straggling fetch entry would overwrite the
                    // live catalog with stale state (or apply the next
                    // delta against the wrong base).
                    settleFetch();
                    fetchHandle?.cancel();
                  }, fetchTimeoutMs)
                : undefined;

            subscription = session.subscribe(
              {
                trackNamespace: source.namespace,
                trackName: source.trackName,
                parameters: { ...parameters, locationFilter: { type: 'largest-object' } },
              },
              {
                onOk: () => {
                  // The relay accepted the subscription — the outage (if
                  // any) is over, so the next failure backs off from the
                  // start again, and the one-shot auth refresh re-arms so
                  // each *established* subscription gets one (§11.4 expects
                  // periodic expiry over a long session).
                  if (!isCurrent()) return;

                  retryAttempts = 0;
                  authRetried = false;
                },
                onObject: (object) => {
                  if (!isCurrent()) return;

                  if (object.status !== 'normal' || object.payload.length === 0) return;

                  const text = utf8Decode(object.payload);

                  if (!fetchSettled) {
                    bufferedLive.push({ groupId: object.groupId, objectId: object.objectId, text });
                    return;
                  }

                  apply(text, object.objectId);
                },
                onDone: (done) => {
                  // PUBLISH_DONE: the publisher ended the catalog track — a
                  // broadcaster disconnect, not a session problem. Poll the
                  // track back into existence; until the broadcaster
                  // returns, each attempt fails and re-enters the error
                  // path's backoff. Auth-shaped ends are the exception: a
                  // re-subscribe carries the same credentials the relay
                  // just rejected, so retrying loops forever.
                  if (!isCurrent()) return;

                  if (!isRetryablePublishDoneStatus(done.statusCode)) {
                    // Terminal: freeze the state — a subscription left open
                    // keeps delivering late objects (and the joining fetch
                    // its replay) into a presentation we just declared done
                    // updating. See `stopCatalog` for why cancelling the
                    // handles alone is not enough.
                    stopCatalog();
                    // TODO(error-management): route to a state-error slot once one exists.
                    console.error('[resolveCatalog] catalog track ended with a non-retryable status:', done);
                    return;
                  }

                  if (!scheduleRestart()) {
                    // TODO(error-management): route to a state-error slot once one exists.
                    console.error('[resolveCatalog] catalog track ended (retry budget spent)');
                  }
                },
                onError: (error) => {
                  // A superseded attempt's failure is not this attempt's:
                  // the live attempt hears its own errors — including its
                  // own auth expiry, if the token really is stale.
                  if (!isCurrent()) return;

                  if (error.errorCode === REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN) {
                    // Auth-expiry retry (MSF §11.4), same one-shot pattern
                    // as track-subscriber: refresh the token and recreate
                    // the subscription + joining fetch with fresh
                    // parameters. `onOk` re-arms the shot.
                    if (!authRetried) {
                      authRetried = true;
                      // `.catch()` after `.then()` (not a rejection handler
                      // on the same `.then()`) so a synchronous throw from
                      // `start()` is contained rather than becoming an
                      // unhandled rejection.
                      void actor
                        .refreshAuthToken()
                        .then((refreshed) => {
                          // A refresh landing after this attempt was
                          // superseded — a terminal stop, a timer-driven
                          // restart, cleanup — must not restart on its
                          // own: it would undo a terminal freeze, or
                          // double-start over a live newer attempt.
                          if (cancelled || !isCurrent()) return;

                          fetchHandle?.cancel();
                          subscription?.cancel();
                          start(refreshed);
                        })
                        .catch((refreshError) => {
                          // TODO(error-management): route to a state-error slot once one exists.
                          console.error('[resolveCatalog] auth refresh failed:', refreshError);

                          // No usable token is coming: terminal, same
                          // freeze as the other terminal branches — unless
                          // the attempt was already superseded, in which
                          // case the live attempt is not ours to stop.
                          if (cancelled || !isCurrent()) return;

                          stopCatalog();
                        });
                      return;
                    }

                    // The refreshed token was rejected too. The generic
                    // retry below would loop forever on a token the relay
                    // just refused — stop instead, freezing the state like
                    // any other permanent rejection.
                    stopCatalog();
                    // TODO(error-management): route to a state-error slot once one exists.
                    console.error('[resolveCatalog] catalog subscribe failed after auth refresh:', error);
                    return;
                  }

                  // A permanent rejection — wrong credentials, malformed
                  // request, unsupported feature — answers an identical
                  // retry identically: stop instead of looping forever, and
                  // stop the joining fetch with it (its replay must not
                  // keep writing into a presentation declared terminal).
                  if (!isRetryableRequestErrorCode(error.errorCode)) {
                    stopCatalog();
                    // TODO(error-management): route to a state-error slot once one exists.
                    console.error('[resolveCatalog] catalog subscribe failed (non-retryable):', error);
                    return;
                  }

                  // The usual meaning is "track does not exist yet" — the
                  // viewer joined before the broadcast, or the broadcaster
                  // is mid-reconnect. Retry with backoff until the track
                  // appears (the session's own loss/recovery cycles this
                  // whole state, so a dead session never loops here).
                  //
                  // A transient failure also re-arms the auth refresh: an
                  // outage can outlive the token, and a retry cycle that
                  // entered on DOES_NOT_EXIST would otherwise read the
                  // eventual EXPIRED_AUTH_TOKEN as "the refreshed token
                  // was rejected" and stop for good. Consecutive expiries
                  // with nothing in between still hit the stop above.
                  authRetried = false;

                  if (!scheduleRestart(error.retryInterval)) {
                    // TODO(error-management): route to a state-error slot once one exists.
                    console.error('[resolveCatalog] catalog subscribe failed (retry budget spent):', error);
                  }
                },
              }
            );

            // Joining fetch (offset 0) replays the current group from its
            // independent catalog object up to the subscription's start.
            fetchHandle = session.fetch(
              {
                type: 'relative-joining',
                joiningRequestId: subscription.requestId,
                joiningStart: 0,
                parameters,
              },
              {
                onEntry: (entry) => {
                  // Once settled (deadline passed or replay ended) the live
                  // subscription owns the catalog — late replay entries are
                  // stale and must not overwrite it.
                  if (!isCurrent() || fetchSettled) return;

                  if (entry.kind !== 'object' || entry.payload.length === 0) return;

                  apply(utf8Decode(entry.payload), entry.objectId);
                },
                onEnd: () => {
                  if (isCurrent()) settleFetch();
                },
                // No history to replay (e.g. nothing published yet) or replay
                // truncated — fall back to live-only: the next independent
                // object resolves.
                onError: () => {
                  if (isCurrent()) settleFetch();
                },
                onReset: () => {
                  if (isCurrent()) settleFetch();
                },
              }
            );
          };

          start(actor.getAuthParameters());

          return () => {
            cancelled = true;
            clearTimeout(settleTimer);
            settleTimer = undefined;
            clearTimeout(retryTimer);
            retryTimer = undefined;
            fetchHandle?.cancel();
            subscription?.cancel();
          };
        },
      },
    },
  });
}

export const resolveCatalog = defineBehavior({
  stateKeys: ['presentation'],
  contextKeys: ['moqSessionActor'],
  setup: setupResolveCatalog,
});
