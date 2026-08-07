/**
 * Capped exponential backoff for connection and subscription retries.
 *
 * One policy shape shared by every MoQ recovery path (session reconnect,
 * catalog re-subscribe, media-track re-subscribe) so an engine tunes retry
 * behavior through one config vocabulary. The delays are jittered ±25% so
 * a fleet of players dropped by the same relay outage does not reconnect
 * in lockstep.
 */

export interface RetryBackoffConfig {
  /** Delay before the first retry, in milliseconds. */
  initialDelayMs: number;
  /** Ceiling the exponential delay is clamped to, in milliseconds. */
  maxDelayMs: number;
  /**
   * Retries allowed before giving up. `Infinity` never gives up — the
   * right default for live playback, where the alternative to retrying
   * is a player that needs a manual reload.
   */
  maxAttempts: number;
}

/**
 * Session (re)connect policy: a relay outage is expected to last seconds
 * to minutes, so the delay grows to a modest polling cadence and holds.
 */
export const DEFAULT_RECONNECT_BACKOFF_CONFIG: RetryBackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/**
 * Subscribe retry policy: a failed SUBSCRIBE usually means the track does
 * not exist *yet* (viewer joined before the broadcast, publisher mid-blip),
 * so the cap stays low — the retry cadence is also the join latency once
 * the track appears.
 */
export const DEFAULT_SUBSCRIBE_RETRY_BACKOFF_CONFIG: RetryBackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 3_000,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/**
 * Ceiling on a server-supplied REQUEST_ERROR Retry Interval (milliseconds).
 * Retry paths honor the server's stated interval above their local backoff,
 * but an absurd value must not park recovery forever.
 */
export const MAX_SERVER_RETRY_INTERVAL_MS = 60_000;

/**
 * Resolve a consumer's partial overrides over a policy's defaults,
 * discarding values that would corrupt the timer math: `retryDelayMs`'s
 * result feeds `setTimeout` directly, and a `NaN` or negative delay turns
 * a paced recovery into a tight loop. Field by field: delays must be
 * finite and non-negative (a bad override falls back to its default), the
 * ceiling is raised to the initial delay when the two cross, and
 * `maxAttempts` must be a non-negative number (`Infinity` is the
 * legitimate never-give-up value; `NaN` falls back).
 */
export function resolveRetryBackoffConfig(
  defaults: RetryBackoffConfig,
  overrides?: Partial<RetryBackoffConfig>
): RetryBackoffConfig {
  const isDelay = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const initialDelayMs = isDelay(overrides?.initialDelayMs) ? overrides.initialDelayMs : defaults.initialDelayMs;
  const maxDelayMs = Math.max(
    initialDelayMs,
    isDelay(overrides?.maxDelayMs) ? overrides.maxDelayMs : defaults.maxDelayMs
  );
  const maxAttempts =
    typeof overrides?.maxAttempts === 'number' && overrides.maxAttempts >= 0
      ? overrides.maxAttempts
      : defaults.maxAttempts;
  return { initialDelayMs, maxDelayMs, maxAttempts };
}

/**
 * Delay before retry number `attempt` (0-based count of failures so far),
 * jittered ±25% and clamped to `maxDelayMs`, or `undefined` once `attempt`
 * exhausts `config.maxAttempts` — the caller's give-up signal.
 *
 * `maxDelayMs` is a hard ceiling: once the exponential base reaches it,
 * the jitter spreads downward only (0.75–1×). A caller stating a maximum
 * recovery cadence gets exactly that, never 125% of it.
 *
 * `random` is a seam for deterministic tests; production callers omit it.
 *
 * @example
 * const delay = retryDelayMs(attempts++, DEFAULT_RECONNECT_BACKOFF_CONFIG);
 * if (delay === undefined) reportFatal(error);
 * else setTimeout(reconnect, delay);
 */
export function retryDelayMs(
  attempt: number,
  config: RetryBackoffConfig,
  random: () => number = Math.random
): number | undefined {
  if (attempt >= config.maxAttempts) return undefined;
  // 2 ** attempt saturates to Infinity for pathological attempt counts;
  // the min() clamps that back to the ceiling.
  const base = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** attempt);
  return Math.min(config.maxDelayMs, base * (0.75 + random() * 0.5));
}
