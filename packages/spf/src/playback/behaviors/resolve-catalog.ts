/**
 * **Resolve a MoQ presentation from its MSF catalog track.** The MoQ analog of `resolve-presentation`: when the session
 * is ready, subscribes to the source's catalog track from the start of the current group — the independent catalog
 * object plus every delta so far, then live updates — parses catalog objects (independent and delta), and writes the
 * projected `Presentation` to `state.presentation`.
 *
 *     'preconditions-unmet' → 'awaiting-session' → 'catalog-active'
 *
 * Unlike `resolvePresentation`'s fetch-once `'resolving' → 'resolved'`, the positive state here spans resolution _and_
 * live updates: the catalog subscription stays open, and every new catalog object re-parses and re-writes
 * `state.presentation` (delta re-parse). Stable track ids (`parse-catalog`) keep unchanged track lists from re-firing
 * selection.
 *
 * Join shape: a `relative-group 1` Location Filter (draft-20 §5.1.2) asks for `{Largest.Group, 0}` onward, and relays
 * serve the already-published head of that group from cache on the ordinary subgroup stream. msf-01 §5 still words the
 * join as SUBSCRIBE plus a Joining FETCH; draft-20 removed Joining FETCH, and against moq-relay a FETCH never carried
 * catalog data anyway — the catalog resolved from the relay's current-group replay. This filter asks for that replay
 * explicitly, so nothing needs buffering or reordering: one stream per group, in order.
 *
 * A delta is applied only against the independent object of its own group. A delta with no base — a mid-group join
 * under a publisher that does not replay — or from a group older than the current base is dropped; the next independent
 * object (object 0 of a group) recovers.
 *
 * Auth-expiry retry (MSF §11.4): an EXPIRED_AUTH_TOKEN subscribe error refreshes the token via the session actor and
 * recreates the catalog subscription once — same pattern as `track-subscriber`.
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
import type { LocationFilter, MessageParameters } from '../../network/moqt/control-messages';
import {
  isRetryablePublishDoneStatus,
  isRetryableRequestErrorCode,
  REQUEST_ERROR_CODE,
} from '../../network/moqt/control-messages';
import type { Subscription } from '../../network/moqt/session';
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
   * Retry policy for a catalog subscription that fails or is ended by the publisher. A failed catalog SUBSCRIBE usually
   * means the track does not exist _yet_ — the viewer pressed play before the broadcast started, or the broadcaster is
   * mid-reconnect — so the retry cadence is also the join latency once it appears. Defaults to
   * {@link DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG}; `maxAttempts: 0` disables retry.
   */
  subscribeRetry?: Partial<RetryBackoffConfig>;
}

/** The current group from its start: the independent catalog object and the deltas published since (§5.1.2). */
const CATALOG_JOIN_FILTER: LocationFilter = { type: 'relative-group', groupsBeforeNext: 1 };

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
          // Group whose independent object `catalog` is built on. Deltas apply
          // only within it; an older group's straggler is stale.
          let baseGroup: number | undefined;
          let cancelled = false;
          let authRetried = false;
          let subscription: Subscription | undefined;
          let retryTimer: ReturnType<typeof setTimeout> | undefined;
          let retryAttempts = 0;
          // Monotonic attempt token: cancelling a subscription does not stop
          // callbacks already in flight, so the retry paths guard every
          // handler against its superseded attempt — a stale object must not
          // touch the fresh attempt's state.
          let attempt = 0;

          const apply = (text: string, groupId: number, objectId: number): void => {
            if (objectId === 0) {
              // Groups travel on separate streams, so an older group's
              // independent object can land after a newer group's. Applying
              // it would roll the presentation back to a superseded catalog.
              if (baseGroup !== undefined && groupId < baseGroup) return;
            } else if (catalog === undefined || groupId !== baseGroup) {
              // A delta with no base can't be interpreted (msf §5.1.6), and
              // one from another group would apply against the wrong base;
              // drop it and recover on the next independent object.
              return;
            }

            try {
              catalog = applyUpdate(catalog, text, updateOptions);

              // The base moves only once its independent object parsed: a
              // malformed one leaves the previous catalog in place, and its
              // group's deltas are dropped rather than applied to it.
              if (objectId === 0) baseGroup = groupId;

              state.presentation.set(moqCatalogToPresentation(catalog, presentation, source.sessionUri));
            } catch (error) {
              // TODO(error-management): route to a state-error slot once one exists.
              console.error('[resolveCatalog] catalog parse failed:', error);
            }
          };

          /**
           * Terminal stop: after this, nothing of the current attempt may write `state.presentation` — and no queued
           * restart may reopen the subscription — until the state re-enters. Cancelling the handle alone is neither: a
           * cancel can itself surface in-flight callbacks, and a restart already booked by an earlier retryable report
           * of the same death (an armed retry timer, or an in-flight auth refresh) would start a fresh attempt right
           * over the terminal state. So the attempt token is bumped (invalidating every handler and the refresh
           * restart, which check it) and the timer disarmed before the handle goes.
           */
          const stopCatalog = (): void => {
            attempt++;
            clearTimeout(retryTimer);
            retryTimer = undefined;
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
           * catalog — dropping deltas until the next independent object (which the new attempt's current-group join
           * replays) is the safe recovery msf §5.1.6 prescribes. `state.presentation` keeps the last resolved value
           * meanwhile, so playback state doesn't flicker.
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

                subscription?.cancel();
                catalog = undefined;
                baseGroup = undefined;
                start(actor.getAuthParameters());
              },
              Math.max(delay, Math.min(retryIntervalMs, MAX_SERVER_RETRY_INTERVAL_MS))
            );
            return true;
          };

          const start = (parameters: MessageParameters): void => {
            const thisAttempt = ++attempt;
            const isCurrent = (): boolean => attempt === thisAttempt;

            subscription = session.subscribe(
              {
                trackNamespace: source.namespace,
                trackName: source.trackName,
                parameters: { ...parameters, locationFilter: CATALOG_JOIN_FILTER },
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

                  apply(utf8Decode(object.payload), object.groupId, object.objectId);
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
                    // keeps delivering late objects into a presentation we
                    // just declared done updating. See `stopCatalog` for why
                    // cancelling the handle alone is not enough.
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
                    // the subscription with fresh parameters. `onOk` re-arms
                    // the shot.
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
                  // retry identically: stop instead of looping forever.
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
          };

          start(actor.getAuthParameters());

          return () => {
            cancelled = true;
            clearTimeout(retryTimer);
            retryTimer = undefined;
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
