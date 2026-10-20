import { Signal } from 'signal-polyfill';

// Keep registration order independently of Watcher: unwatch() swaps the last
// watched computed into the removed slot, which can move a reactor's binding
// effect ahead of its entry effect when another composition is destroyed.
const effects = new Set<Signal.Computed<void>>();

const watcher = new Signal.subtle.Watcher(() => {
  queueMicrotask(runPending);
});

function runPending() {
  const pending = new Set(watcher.getPending());

  watcher.watch(); // re-arm before running effects, in case they write signals

  for (const c of effects) {
    if (!pending.has(c)) continue;

    c.get(); // re-run the effect body
    revalidateSources(c);
  }
}

/**
 * Recover an effect that wrote a signal one of its own dependencies reads.
 *
 * When an effect body writes a signal that an intermediate computed in its own dependency graph consumes (e.g. a
 * track-selection effect writing the selection slot a candidate-set computed consults), the graph can't tell the
 * effect: the write marks the intermediate dirty, but the effect is the in-flight consumer, so no watcher notification
 * fires — and the effect finishes the run _clean but stale_. Worse, every later external change routed through that
 * intermediate is deduped against its standing dirty flag, so the effect never hears about those either (the
 * lost-wakeup).
 *
 * Pulling each source once after the run closes the hole: a dirtied intermediate recomputes and its dirty flag clears,
 * so the _next_ change through it propagates and wakes the effect normally. The guarantee is liveness, not immediacy —
 * the effect is deliberately not re-run just because it wrote into its own graph (that would double-run every writing
 * effect); it catches up on the next genuine change. Sources that are clean, or whose recomputation is equals-gated to
 * the same value, cost a cached read and notify no one.
 */
function revalidateSources(c: Signal.Computed<void>): void {
  for (const source of Signal.subtle.introspectSources(c)) {
    (source as Signal.State<unknown> | Signal.Computed<unknown>).get();
  }
}

/**
 * Run a side effect whenever its signal dependencies change.
 *
 * Executes immediately (synchronous initial run), then re-runs on the next microtask after any dependency changes. If
 * the callback returns a function, it is called before each re-run and when the effect is stopped — the same cleanup
 * contract as Preact Signals, Maverick Signals, and Svelte 5 $effect.
 *
 * Returns a cleanup function that stops the effect.
 */
export function effect(fn: () => (() => void) | void): () => void {
  let cleanup: (() => void) | void;
  const c = new Signal.Computed(() => {
    if (typeof cleanup === 'function') cleanup();

    cleanup = fn();
  });

  effects.add(c);
  watcher.watch(c);
  c.get(); // initial run
  revalidateSources(c); // an initial run may self-write too — see the note
  return () => {
    if (!effects.delete(c)) return;

    watcher.unwatch(c);

    if (typeof cleanup === 'function') cleanup();
  };
}
