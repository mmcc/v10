import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECONNECT_BACKOFF_CONFIG,
  type RetryBackoffConfig,
  resolveRetryBackoffConfig,
  retryDelayMs,
} from '../retry-backoff';

const config: RetryBackoffConfig = { initialDelayMs: 500, maxDelayMs: 4000, maxAttempts: 5 };

describe('retryDelayMs', () => {
  it('doubles from the initial delay and clamps at the ceiling', () => {
    // random = 0.5 → jitter factor exactly 1.
    const noJitter = () => 0.5;
    expect(retryDelayMs(0, config, noJitter)).toBe(500);
    expect(retryDelayMs(1, config, noJitter)).toBe(1000);
    expect(retryDelayMs(2, config, noJitter)).toBe(2000);
    expect(retryDelayMs(3, config, noJitter)).toBe(4000);
    expect(retryDelayMs(4, config, noJitter)).toBe(4000);
  });

  it('jitters within ±25% of the base delay', () => {
    expect(retryDelayMs(0, config, () => 0)).toBe(375);
    expect(retryDelayMs(0, config, () => 1)).toBe(625);
  });

  it('never jitters past the ceiling — maxDelayMs is a hard contract', () => {
    expect(retryDelayMs(3, config, () => 1)).toBe(4000);
    expect(retryDelayMs(4, config, () => 1)).toBe(4000);
  });

  it('returns undefined once attempts are exhausted', () => {
    expect(retryDelayMs(5, config)).toBeUndefined();
    expect(retryDelayMs(6, config)).toBeUndefined();
  });

  it('never gives up under the default infinite budget', () => {
    expect(retryDelayMs(10_000, DEFAULT_RECONNECT_BACKOFF_CONFIG, () => 0.5)).toBe(
      DEFAULT_RECONNECT_BACKOFF_CONFIG.maxDelayMs
    );
  });

  it('a zero-attempt budget refuses the first retry', () => {
    expect(retryDelayMs(0, { ...config, maxAttempts: 0 })).toBeUndefined();
  });
});

describe('resolveRetryBackoffConfig', () => {
  it('applies valid overrides over the defaults', () => {
    expect(resolveRetryBackoffConfig(config, { initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 })).toEqual({
      initialDelayMs: 100,
      maxDelayMs: 200,
      maxAttempts: 3,
    });
    expect(resolveRetryBackoffConfig(config, { maxAttempts: Number.POSITIVE_INFINITY }).maxAttempts).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(resolveRetryBackoffConfig(config)).toEqual(config);
  });

  it('discards values that would corrupt the timer math', () => {
    // The result feeds setTimeout directly: NaN or negative delays turn a
    // paced recovery into a tight loop.
    expect(
      resolveRetryBackoffConfig(config, {
        initialDelayMs: Number.NaN,
        maxDelayMs: -1,
        maxAttempts: Number.NaN,
      })
    ).toEqual(config);
    expect(resolveRetryBackoffConfig(config, { initialDelayMs: Number.POSITIVE_INFINITY }).initialDelayMs).toBe(
      config.initialDelayMs
    );
  });

  it('raises the ceiling to a crossing initial delay', () => {
    expect(resolveRetryBackoffConfig(config, { initialDelayMs: 10_000 })).toEqual({
      initialDelayMs: 10_000,
      maxDelayMs: 10_000,
      maxAttempts: config.maxAttempts,
    });
  });
});
