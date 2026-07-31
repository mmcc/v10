/**
 * **Own the publish transport session.** While an `endpoint` is set,
 * `publishActivated` is true, and capture is `'active'`, connects through
 * `config.connectTransport` (default: a real `WebTransport`), creates the
 * publish-session actor, publishes it on `context.publishSessionActor`,
 * and mirrors the actor's lifecycle into `state.sessionStatus`
 * (`connecting → ready → live`, `draining` on GOAWAY, `error` on
 * failure). When the gate collapses — unpublish, capture release, or
 * teardown — the actor is destroyed, which sends PUBLISH_DONE for every
 * still-live track, drains those control writes briefly, and closes the
 * transport; `sessionStatus` settles on `'closed'` (a prior `'error'` is
 * preserved).
 *
 * DOM-free: the session drives a structural `MoqtTransport`, and the
 * `WebTransport` default comes from the WebWorker lib (the same shape the
 * playback `moq-session` actor uses), so only tests and alternative hosts
 * need to inject `connectTransport`.
 *
 * Sole writer of `state.sessionStatus` and `context.publishSessionActor`;
 * co-writer of `state.publishError` (transport/protocol failures only).
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import { peek, type ReadonlySignal, type Signal } from '../../core/signals/primitives';
import { isMoqtProtocolError } from '../../network/moqt/errors';
import type {
  ConnectPublishTransport,
  PublishEndpoint,
  PublishSessionActor,
  PublishSessionActorStatus,
} from '../session/publish-session';
import { createPublishSessionActor } from '../session/publish-session';

/**
 * Publish session lifecycle as engine state.
 *
 * `ready` — transport + setup complete, namespace announced, no accepted
 * track offer yet. `live` — the peer accepted at least one PUBLISH.
 * `draining` — orderly shutdown (unpublish or GOAWAY).
 */
export type PublishSessionStatus = 'idle' | 'connecting' | 'ready' | 'live' | 'draining' | 'closed' | 'error';

/**
 * Structural mirror of `behaviors/dom/acquire-capture-source.ts`'s
 * `CaptureStatus` (DOM-bound, so not importable here) — keep identical.
 */
export type CaptureStatusFacts = 'idle' | 'acquiring' | 'active' | 'denied' | 'ended';

/**
 * Structural mirror of `behaviors/dom/acquire-capture-source.ts`'s
 * `PublishErrorFacts` — keep identical.
 */
export interface SessionPublishErrorFacts {
  code: 'capture' | 'encode' | 'transport' | 'protocol';
  message: string;
  cause?: unknown;
}

export interface OpenPublishSessionState {
  endpoint?: PublishEndpoint | undefined;
  publishActivated?: boolean;
  captureStatus?: CaptureStatusFacts;
  sessionStatus?: PublishSessionStatus;
  publishError?: SessionPublishErrorFacts | undefined;
}

export interface OpenPublishSessionContext {
  publishSessionActor?: PublishSessionActor | undefined;
}

export interface OpenPublishSessionConfig {
  /** Transport seam; default constructs a real `WebTransport`. */
  connectTransport?: ConnectPublishTransport;
  /** Control-request response bound forwarded to the session driver. */
  requestTimeoutMs?: number;
}

type OpenPublishSessionFsmState = 'no-session' | 'session-open';

const STATUS_FACTS: Record<PublishSessionActorStatus, PublishSessionStatus> = {
  connecting: 'connecting',
  ready: 'ready',
  live: 'live',
  draining: 'draining',
  closed: 'closed',
  failed: 'error',
};

function openPublishSessionSetup({
  state,
  context,
  config = {},
}: {
  state: {
    endpoint: ReadonlySignal<OpenPublishSessionState['endpoint']>;
    publishActivated: ReadonlySignal<OpenPublishSessionState['publishActivated']>;
    captureStatus: ReadonlySignal<OpenPublishSessionState['captureStatus']>;
    sessionStatus: Signal<OpenPublishSessionState['sessionStatus']>;
    publishError: Signal<OpenPublishSessionState['publishError']>;
  };
  context: {
    publishSessionActor: Signal<OpenPublishSessionContext['publishSessionActor']>;
  };
  config?: OpenPublishSessionConfig;
}): Reactor<OpenPublishSessionFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<OpenPublishSessionFsmState>({
    initial: 'no-session',
    monitor: () =>
      state.endpoint.get() && state.publishActivated.get() === true && state.captureStatus.get() === 'active'
        ? 'session-open'
        : 'no-session',
    states: {
      'no-session': {},

      'session-open': {
        effects: [
          // Owner effect — an endpoint identity change reconnects through
          // the cleanup.
          () => {
            const endpoint = state.endpoint.get()!;
            // A fresh attempt clears the previous session failure (ours);
            // capture/encode failures belong to their own writers.
            const previous = peek(state.publishError);
            if (previous && (previous.code === 'transport' || previous.code === 'protocol')) {
              state.publishError.set(undefined);
            }
            state.sessionStatus.set('connecting');
            const actor = createPublishSessionActor({
              endpoint,
              connectTransport: config.connectTransport,
              requestTimeoutMs: config.requestTimeoutMs,
            });
            context.publishSessionActor.set(actor);

            return () => {
              context.publishSessionActor.set(undefined);
              // A terminal 'error' outlives the teardown so consumers can
              // still read why publishing stopped.
              const failed = peek(state.sessionStatus) === 'error';
              if (!failed) state.sessionStatus.set('draining');
              // Destroy sends PUBLISH_DONE for still-live tracks, drains
              // the control writes briefly, and closes the transport; its
              // 'closed' callback lands after this effect is already
              // disposed, so the facts are written here. Track publishers
              // reacting to the slot clearing below get their own
              // PUBLISH_DONE (with real stream counts) in before the
              // drain's last-resort sweep.
              actor.destroy();
              if (!failed) state.sessionStatus.set('closed');
            };
          },

          // Facts sync — mirrors the actor snapshot into engine state.
          () => {
            const actor = context.publishSessionActor.get();
            if (!actor) return;
            const snapshot = actor.snapshot.get();
            const status = snapshot.context.status;
            state.sessionStatus.set(STATUS_FACTS[status]);
            if (status === 'failed' || status === 'closed') {
              // An unexpected close while the gate is still open is a
              // transport failure too — our own teardown never syncs here
              // (the effect is disposed first).
              const error = snapshot.context.error;
              state.publishError.set({
                code: isMoqtProtocolError(error) ? 'protocol' : 'transport',
                message: error instanceof Error ? error.message : 'The publish session closed before it was stopped.',
                cause: error,
              });
              if (status === 'closed') state.sessionStatus.set('error');
            }
          },
        ],
      },
    },
  });
}

export const openPublishSession = defineBehavior({
  stateKeys: ['endpoint', 'publishActivated', 'captureStatus', 'sessionStatus', 'publishError'],
  contextKeys: ['publishSessionActor'],
  setup: openPublishSessionSetup,
});
