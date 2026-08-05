import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import { suspendMediaWhilePaused } from '../suspend-media-while-paused';

function makeDeps() {
  return {
    state: {
      paused: signal<boolean | undefined>(undefined),
      targetLatency: signal<number | undefined>(undefined),
      adaptiveTargetLatency: signal<number | undefined>(undefined),
      mediaSuspended: signal<boolean | undefined>(undefined),
    },
  };
}

// Default hold window: defaultTargetLatency (0.5s) + catchUpThreshold (3s).
const DEFAULT_HOLD_MS = 3_500;

describe('suspendMediaWhilePaused', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never suspends while playing', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS * 2);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    reactor.destroy();
  });

  it('keeps media intact through a transient pause', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 100);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    deps.state.paused.set(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS * 2);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    reactor.destroy();
  });

  it('suspends once a pause outlives the hold window', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 100);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('clears the suspension immediately on play', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    deps.state.paused.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    reactor.destroy();
  });

  it('restarts the hold window on each new pause', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 100);
    deps.state.paused.set(false);
    await vi.advanceTimersByTimeAsync(0);

    // The earlier near-complete pause must not carry over.
    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 100);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('derives the hold window from the consumer target latency', async () => {
    const deps = makeDeps();
    deps.state.targetLatency.set(2); // hold = 2s + 3s catch-up threshold
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  // The window means "the depth at which the controller starts discarding
  // the paused buffer anyway", so it has to derive from the target the
  // controller is actually holding — not from an input it is ignoring.
  it('derives the hold window from the adaptive target where the consumer set none', async () => {
    const deps = makeDeps();
    deps.state.adaptiveTargetLatency.set(0.2); // hold = 0.2s + 3s catch-up threshold
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('keeps the consumer target ahead of the adaptive one', async () => {
    const deps = makeDeps();
    deps.state.targetLatency.set(2);
    deps.state.adaptiveTargetLatency.set(0.2);
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('honors an explicit pauseHoldSeconds over the derived default', async () => {
    const deps = makeDeps();
    deps.state.targetLatency.set(10);
    const reactor = suspendMediaWhilePaused.setup({ ...deps, config: { pauseHoldSeconds: 1 } });

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('derives the hold window from latency config overrides', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup({
      ...deps,
      config: { latency: { defaultTargetLatency: 1, catchUpThreshold: 1 } },
    });

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('falls back to the default hold when the consumer target latency is invalid', async () => {
    const deps = makeDeps();
    // setTimeout would coerce the NaN-derived delay to zero — an invalid
    // consumer value must not turn every pause into an immediate suspend.
    deps.state.targetLatency.set(Number.NaN);
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 100);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('ignores an invalid pauseHoldSeconds and derives the hold window instead', async () => {
    const deps = makeDeps();
    deps.state.targetLatency.set(2); // derived hold = 2s + 3s catch-up threshold
    const reactor = suspendMediaWhilePaused.setup({ ...deps, config: { pauseHoldSeconds: -1 } });

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
  });

  it('never suspends when the hold deadline races a resume ahead of the effect flush', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS - 1);

    // Resume, then fire the due timer synchronously — before the reactor's
    // cleanup (which runs on the microtask effect flush) can clear it.
    deps.state.paused.set(false);
    vi.advanceTimersByTime(1);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS * 2);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    reactor.destroy();
  });

  it('clears the suspension and pending timer on destroy', async () => {
    const deps = makeDeps();
    const reactor = suspendMediaWhilePaused.setup(deps);

    deps.state.paused.set(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS);
    expect(deps.state.mediaSuspended.get()).toBe(true);

    reactor.destroy();
    expect(deps.state.mediaSuspended.get()).toBeUndefined();

    // A destroyed reactor must not fire a stale timer back into the slot.
    await vi.advanceTimersByTimeAsync(DEFAULT_HOLD_MS * 2);
    expect(deps.state.mediaSuspended.get()).toBeUndefined();
  });
});
