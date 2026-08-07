/**
 * **Own the MoQ session actor for the current source.** When
 * `state.presentation` holds a `moqt://` URL and the preload /
 * load-activation gate is met, parses the MSF source (relay URL + `msf:`
 * fragment, §11.1), creates the moq-session actor (which connects), and
 * publishes it on `context.moqSessionActor`. Source change, gate close,
 * and destroy all tear the session down through state exit.
 *
 * Mirrors `setupMediaSource`'s single-positive-state shape, with
 * `resolvePresentation`-style preload gating:
 *
 * ```
 * 'preconditions-unmet' → 'idle' → 'session-active'
 * ```
 *
 * Sole writer of `context.moqSessionActor`; MoQ behaviors downstream
 * (`resolveCatalog`, `subscribeSelected*Track`) only read.
 *
 * The `authProvider` config seam (MSF §11.4) rides through to the actor:
 * initial token attach on connect/subscribe, refresh + retry on
 * auth-expiry errors.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { computed, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import { isMoqSourceUrl, parseMoqSource } from '../../media/moq/parse-source';
import type { MaybeResolvedPresentation } from '../../media/types';
import { DEFAULT_PRELOAD, isBlockingPreload, type StandardPreload } from '../../media/utils/preload';
import type { RetryBackoffConfig } from '../../network/retry-backoff';
import {
  type CreateMoqTransport,
  createMoqSessionActor,
  type MoqAuthProvider,
  type MoqSessionActor,
} from '../actors/moq-session';

export interface MoqSessionState {
  presentation?: MaybeResolvedPresentation;
  preload?: 'auto' | 'metadata' | 'none' | undefined;
  loadActivated?: boolean;
}

export interface MoqSessionContext {
  moqSessionActor?: MoqSessionActor;
}

export interface SetupMoqSessionConfig {
  /** Transport factory override — tests inject an in-memory fake. */
  createMoqTransport?: CreateMoqTransport;
  /** MSF §11.4 token workflow: initial token supply + expiry refresh. */
  authProvider?: MoqAuthProvider;
  /** Fallback when `state.preload` is unset. Defaults to `'metadata'`. */
  defaultPreload?: StandardPreload;
  /** Session reconnect policy — rides through to the session actor. */
  reconnect?: Partial<RetryBackoffConfig>;
}

type MoqSessionFsmState = 'preconditions-unmet' | 'idle' | 'session-active';

function deriveState(
  presentation: MaybeResolvedPresentation | undefined,
  preload: MoqSessionState['preload'],
  loadActivated: boolean | undefined,
  defaultPreload: StandardPreload
): MoqSessionFsmState {
  if (!presentation?.url || !isMoqSourceUrl(presentation.url)) return 'preconditions-unmet';
  const gateOpen = !!loadActivated || !isBlockingPreload(preload, defaultPreload);
  return gateOpen ? 'session-active' : 'idle';
}

function setupMoqSessionSetup({
  state,
  context,
  config,
}: {
  state: {
    presentation: ReadonlySignal<MoqSessionState['presentation']>;
    preload: ReadonlySignal<MoqSessionState['preload']>;
    loadActivated: ReadonlySignal<MoqSessionState['loadActivated']>;
  };
  context: {
    moqSessionActor: Signal<MoqSessionContext['moqSessionActor']>;
  };
  config?: SetupMoqSessionConfig;
}): Reactor<MoqSessionFsmState | 'destroying' | 'destroyed'> {
  const defaultPreload = config?.defaultPreload ?? DEFAULT_PRELOAD;

  const derivedStateSignal = computed(() =>
    deriveState(state.presentation.get(), state.preload.get(), state.loadActivated.get(), defaultPreload)
  );

  // Memoized source identity: the presentation object churns on catalog
  // resolution/updates (same url), but the session must only cycle when
  // the *url* changes — a direct moqt→moqt URL replacement never leaves
  // 'session-active', so the effect below keys on this instead.
  const sourceUrlSignal = computed(() => state.presentation.get()?.url);

  return createMachineReactor<MoqSessionFsmState>({
    initial: 'preconditions-unmet',
    monitor: () => derivedStateSignal.get(),
    states: {
      'preconditions-unmet': {},
      idle: {},
      'session-active': {
        // The session's valid lifespan is exactly this state *and* this
        // source url — the tracked url read makes a direct URL replacement
        // tear down the old session (cleanup) and connect the new one,
        // while gate close / source clear / destroy exit the state.
        effects: () => {
          const url = sourceUrlSignal.get()!;
          let source: ReturnType<typeof parseMoqSource>;
          try {
            source = parseMoqSource(url);
          } catch (error) {
            // TODO(error-management): route to a state-error slot once one exists.
            console.error('[setupMoqSession] invalid MSF source URL:', error);
            return;
          }

          const actor = createMoqSessionActor({
            source,
            createTransport: config?.createMoqTransport,
            authProvider: config?.authProvider,
            reconnect: config?.reconnect,
          });
          context.moqSessionActor.set(actor);

          return () => {
            actor.destroy();
            context.moqSessionActor.set(undefined);
          };
        },
      },
    },
  });
}

export const setupMoqSession = defineBehavior({
  stateKeys: ['presentation', 'preload', 'loadActivated'],
  contextKeys: ['moqSessionActor'],
  setup: setupMoqSessionSetup,
});
