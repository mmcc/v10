/**
 * MoQ timeline math: group/object ↔ media-time mapping via the MSF media timeline template (msf-01 §7.4), MSF
 * time-alignment for cross-track switch points (§4.2), and live-edge/latency arithmetic.
 *
 * Pure functions over plain data — no signals, no wire types.
 */
import { MICROSECONDS_PER_SECOND } from './loc';

// ============================================================================
// Media timeline template (§7.4)
// ============================================================================

/**
 * Parsed form of the six-element template array carried in a track's `template` field: `[startMediaTime,
 * deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock]`.
 */
export interface MediaTimelineTemplate {
  /** Media time of entry 0 in milliseconds. */
  startMediaTime: number;
  /** Constant media-time interval between entries in milliseconds. */
  deltaMediaTime: number;
  startLocation: { group: number; object: number };
  deltaLocation: { group: number; object: number };
  /** Wallclock of entry 0 in Unix-epoch milliseconds (0 = unknown/VOD). */
  startWallclock: number;
  deltaWallclock: number;
}

/** Parse the raw JSON template array. Returns `null` when malformed. */
export function parseMediaTimelineTemplate(raw: unknown): MediaTimelineTemplate | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;

  const [startMediaTime, deltaMediaTime, startLocation, deltaLocation, startWallclock, deltaWallclock] = raw;

  if (
    typeof startMediaTime !== 'number' ||
    typeof deltaMediaTime !== 'number' ||
    typeof startWallclock !== 'number' ||
    typeof deltaWallclock !== 'number' ||
    !Array.isArray(startLocation) ||
    !Array.isArray(deltaLocation) ||
    typeof startLocation[0] !== 'number' ||
    typeof startLocation[1] !== 'number' ||
    typeof deltaLocation[0] !== 'number' ||
    typeof deltaLocation[1] !== 'number'
  ) {
    return null;
  }

  return {
    startMediaTime,
    deltaMediaTime,
    startLocation: { group: startLocation[0], object: startLocation[1] },
    deltaLocation: { group: deltaLocation[0], object: deltaLocation[1] },
    startWallclock,
    deltaWallclock,
  };
}

/**
 * Media time (milliseconds) of a group's first entry per the template, or `null` when the template's group stride is
 * zero (object-indexed templates need object-level resolution the caller must do itself), the group precedes the
 * template start, or the group falls between stride entries (no template entry exists for it).
 */
export function templateMediaTimeForGroup(template: MediaTimelineTemplate, groupId: number): number | null {
  if (template.deltaLocation.group === 0) return null;

  const index = (groupId - template.startLocation.group) / template.deltaLocation.group;
  if (!Number.isInteger(index) || index < 0) return null;

  return template.startMediaTime + index * template.deltaMediaTime;
}

/** Group whose template entry covers `mediaTimeMs`, or `null` (see above). */
export function templateGroupForMediaTime(template: MediaTimelineTemplate, mediaTimeMs: number): number | null {
  if (template.deltaLocation.group === 0 || template.deltaMediaTime <= 0) return null;

  const index = Math.floor((mediaTimeMs - template.startMediaTime) / template.deltaMediaTime);
  if (index < 0) return null;

  return template.startLocation.group + index * template.deltaLocation.group;
}

// ============================================================================
// Time alignment / switch points (§4.2)
// ============================================================================

/**
 * The first group at which a make-before-break track switch may land. MSF time-aligns alternate-group tracks at equal
 * group numbers, and a group always starts with a random-access point — so the earliest clean handoff is the next group
 * after the one currently rendering.
 */
export function nextSwitchGroup(currentGroupId: number): number {
  return currentGroupId + 1;
}

/**
 * Whether a switch from `fromTrackAltGroup` to `toTrackAltGroup` can rely on group-number alignment (§4.2: tracks in a
 * common alternate group MUST be time-aligned). `undefined` alt groups never align.
 */
export function isTimeAligned(fromAltGroup: number | undefined, toAltGroup: number | undefined): boolean {
  return fromAltGroup !== undefined && fromAltGroup === toAltGroup;
}

// ============================================================================
// Live-edge / latency math
// ============================================================================

/**
 * Glass-to-glass latency estimate in seconds for a frame whose LOC timestamp is wallclock-anchored (no timescale ⇒
 * microseconds since the Unix epoch): how far behind "now" the frame was captured.
 */
export function estimateLatencySeconds(frameTimestampUs: number, nowEpochMs: number): number {
  return nowEpochMs / 1000 - frameTimestampUs / MICROSECONDS_PER_SECOND;
}

/** Jitter-buffer depth in seconds between the newest buffered frame and the frame currently being played out. */
export function bufferDepthSeconds(newestTimestampUs: number, playoutTimestampUs: number): number {
  return Math.max(0, (newestTimestampUs - playoutTimestampUs) / MICROSECONDS_PER_SECOND);
}

/**
 * Whether a stated target latency can be used as a setpoint at all.
 *
 * Not defensive tidiness — an unusable number does not degrade this pipeline, it stops it, and both failures are
 * silent:
 *
 * - **`NaN`** makes every comparison in the latency controller false, so the controller parks the rate at `1 − rateNudge`
 *   forever, and it propagates through `joinAnchorUs` into the video self-clock's slew, which writes the corrected
 *   value back as its own anchor. One `NaN` read leaves the clock permanently `NaN`, no frame is ever due again, and
 *   nothing but a track switch clears it.
 * - **Zero or negative** places the join anchor at or _ahead_ of the delivery edge, where the audio renderer discards its
 *   whole buffer unheard on every tick and the video renderer drop-lates everything it holds.
 *
 * So an unusable value is treated as _no statement_, and resolution falls through to the next layer that made one — the
 * same rule `<simple-moq-video>` applies to its `target-latency` attribute, applied where every source of a target
 * passes rather than only that one.
 */
export function isUsableTargetSeconds(seconds: number | undefined): seconds is number {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
}

/**
 * Target latency in seconds, resolved across the layers allowed to state one: consumer input wins, then the track
 * catalog's `targetLatency` (milliseconds, msf-01 §5.2.8), then the controller default. Shared by the latency
 * controller and the renderers so both aim at one number.
 *
 * A layer that states something unusable (see `isUsableTargetSeconds`) is skipped rather than honored — including the
 * catalog, which is a remote publisher's number and the one layer nothing else validates.
 *
 * `defaultTargetSeconds` is the one layer this function cannot skip: it is the bottom of the chain, so there is nothing
 * below it to fall through to. It is guaranteed usable by `resolveLatencyControlConfig`, which is where every caller's
 * `LatencyControlConfig` comes from — pass a raw `config.latency` here and the guarantee is gone.
 */
export function resolveTargetLatencySeconds(
  consumerTargetSeconds: number | undefined,
  catalogTargetMs: number | undefined,
  defaultTargetSeconds: number
): number {
  if (isUsableTargetSeconds(consumerTargetSeconds)) return consumerTargetSeconds;

  const catalogTargetSeconds = catalogTargetMs === undefined ? undefined : catalogTargetMs / 1000;
  if (isUsableTargetSeconds(catalogTargetSeconds)) return catalogTargetSeconds;

  return defaultTargetSeconds;
}

/**
 * The value to feed `resolveTargetLatencySeconds` as its consumer target when adaptive latency is in play: **an
 * explicit consumer target always wins over the adaptive controller's proposal.** Setting `targetLatency` therefore
 * pins the setpoint whether or not adaptation is running, and `undefined` from both leaves the catalog → default chain
 * below it untouched — which is exactly what a warming-up (or disabled) adaptive controller publishes.
 *
 * A one-line rule with two readers (`syncLatency` and the renderers' `makeEdgeTargetUs`), named so the precedence lives
 * in one place rather than as a `??` that can be spelled differently in each.
 *
 * Precedence goes by _usability_, not by presence: a consumer target of `NaN` or `-1` is not a low target, it is a
 * target that was never stated (see `isUsableTargetSeconds`), so the adaptive proposal below it still gets its turn
 * instead of being shadowed by a number nothing can hold.
 */
export function preferredTargetLatencySeconds(
  consumerTargetSeconds: number | undefined,
  adaptiveTargetSeconds: number | undefined
): number | undefined {
  if (isUsableTargetSeconds(consumerTargetSeconds)) return consumerTargetSeconds;

  if (isUsableTargetSeconds(adaptiveTargetSeconds)) return adaptiveTargetSeconds;

  return undefined;
}

/**
 * Media timestamp playout should join a jitter buffer at: `targetLatencySeconds` behind the newest buffered frame. A
 * relay replays several recent groups to every joining subscriber, so anchoring at the oldest buffered frame instead
 * parks playout that whole replay behind the live edge.
 */
export function joinAnchorUs(newestTimestampUs: number, targetLatencySeconds: number): number {
  return newestTimestampUs - targetLatencySeconds * MICROSECONDS_PER_SECOND;
}

/**
 * Media-time step beyond which two readings of one broadcast are on different timelines — a timeline reset — rather
 * than a gap, a reorder, or ordinary cross-track skew within one.
 *
 * Nothing in MoQ/LOC promises a track's timestamps are continuous for the life of a subscription: a publisher whose
 * capture source is replaced mid-stream re-anchors that track's timeline (its encoder anchors capture time to wallclock
 * once per capture pipeline), a latency catch-up skips groups, and wallclock anchoring itself can step. Every consumer
 * that compares media times across such a step — renderer clocks, delivery edges, join anchors — needs the same notion
 * of "too far to be the same timeline", or one of them re-anchors while another keeps serving numbers from the departed
 * timeline.
 *
 * One second: comfortably above jitter-buffer reorder and cross-track delivery skew (~a group), comfortably below the
 * multi-second steps a source switch or clock step produces.
 */
export const TIMELINE_DISCONTINUITY_US = 1_000_000;
