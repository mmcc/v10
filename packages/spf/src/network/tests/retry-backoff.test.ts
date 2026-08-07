import { describe, expect, it } from 'vitest';
import { DEFAULT_RECONNECT_BACKOFF_CONFIG, type RetryBackoffConfig, retryDelayMs } from '../retry-backoff';

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
