/**
 * **Resolve a MoQ presentation from its MSF catalog track.** The MoQ
 * analog of `resolve-presentation`: when the session is ready, subscribes
 * to the source's catalog track — per msf-01 §5, SUBSCRIBE plus a joining
 * FETCH (offset 0) to obtain the latest complete catalog and every
 * subsequent update — parses catalog objects (independent and delta), and
 * writes the projected `Presentation` to `state.presentation`.
 *
 * ```
 * 'preconditions-unmet' → 'awaiting-session' → 'catalog-active'
 * ```
 *
 * Unlike `resolvePresentation`'s fetch-once `'resolving' → 'resolved'`,
 * the positive state here spans resolution *and* live updates: the
 * catalog subscription stays open, and every new catalog object re-parses
 * and re-writes `state.presentation` (delta re-parse). Stable track ids
 * (`parse-catalog`) keep unchanged track lists from re-firing selection.
 *
 * Ordering: live delta objects can arrive while the joining fetch is
 * still replaying the current group, so live objects buffer until the
 * fetch settles, then apply in (group, object) order. A delta that lands
 * with no prior catalog (fetch unavailable, e.g. nothing published) is
 * dropped — the next independent object (object 0 of a group) recovers.
 *
 * Auth-expiry retry (MSF §11.4): an EXPIRED_AUTH_TOKEN subscribe error
 * refreshes the token via the session actor and recreates the catalog
 * subscription + joining fetch once — same pattern as `track-subscriber`.
 *
 * Multi-writer on `state.presentation` with the engine adapter (initial
 * `{ url }` input) — same legitimate split as `resolvePresentation`.
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
import { REQUEST_ERROR_CODE } from '../../network/moqt/control-messages';
import type { FetchHandle, Subscription } from '../../network/moqt/session';
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
   * Deadline for the joining fetch's replay. The session's request timeout
   * only covers a fetch that never answers — a relay that sends FETCH_OK
   * and then never opens (or never finishes) its data stream would leave
   * `fetchSettled` false forever, buffering live deltas and never resolving
   * a catalog. On expiry the behavior falls back to live-only, exactly as it
   * does for an empty or truncated replay. Default 5000ms.
   */
  catalogFetchTimeoutMs?: number;
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

          const start = (parameters: MessageParameters): void => {
            // Fresh attempt: the new joining fetch replays the current
            // group again, so live deltas must buffer until it settles.
            fetchSettled = false;
            bufferedLive.length = 0;
            clearTimeout(settleTimer);
            settleTimer = fetchTimeoutMs > 0 ? setTimeout(settleFetch, fetchTimeoutMs) : undefined;

            subscription = session.subscribe(
              {
                trackNamespace: source.namespace,
                trackName: source.trackName,
                parameters: { ...parameters, locationFilter: { type: 'largest-object' } },
              },
              {
                onObject: (object) => {
                  if (object.status !== 'normal' || object.payload.length === 0) return;
                  const text = utf8Decode(object.payload);
                  if (!fetchSettled) {
                    bufferedLive.push({ groupId: object.groupId, objectId: object.objectId, text });
                    return;
                  }
                  apply(text, object.objectId);
                },
                onError: (error) => {
                  // Auth-expiry retry (MSF §11.4), same one-shot pattern as
                  // track-subscriber: refresh the token and recreate the
                  // subscription + joining fetch with fresh parameters.
                  if (error.errorCode === REQUEST_ERROR_CODE.EXPIRED_AUTH_TOKEN && !authRetried) {
                    authRetried = true;
                    // `.catch()` after `.then()` (not a rejection handler on
                    // the same `.then()`) so a synchronous throw from
                    // `start()` is contained rather than becoming an
                    // unhandled rejection.
                    void actor
                      .refreshAuthToken()
                      .then((refreshed) => {
                        if (cancelled) return;
                        fetchHandle?.cancel();
                        subscription?.cancel();
                        start(refreshed);
                      })
                      .catch((refreshError) => {
                        // TODO(error-management): route to a state-error slot once one exists.
                        console.error('[resolveCatalog] auth refresh failed:', refreshError);
                      });
                    return;
                  }
                  // TODO(error-management): route to a state-error slot once one exists.
                  console.error('[resolveCatalog] catalog subscribe failed:', error);
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
                  if (entry.kind !== 'object' || entry.payload.length === 0) return;
                  apply(utf8Decode(entry.payload), entry.objectId);
                },
                onEnd: settleFetch,
                // No history to replay (e.g. nothing published yet) or replay
                // truncated — fall back to live-only: the next independent
                // object resolves.
                onError: settleFetch,
                onReset: settleFetch,
              }
            );
          };

          start(actor.getAuthParameters());

          return () => {
            cancelled = true;
            clearTimeout(settleTimer);
            settleTimer = undefined;
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
