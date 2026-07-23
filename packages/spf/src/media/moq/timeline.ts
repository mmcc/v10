/**
 * MoQ timeline math: group/object ↔ media-time mapping via the MSF media
 * timeline template (msf-01 §7.4), MSF time-alignment for cross-track
 * switch points (§4.2), and live-edge/latency arithmetic.
 *
 * Pure functions over plain data — no signals, no wire types.
 */
import { MICROSECONDS_PER_SECOND } from './loc';

// ============================================================================
// Media timeline template (§7.4)
// ============================================================================

/**
 * Parsed form of the six-element template array carried in a track's
 * `template` field: `[startMediaTime, deltaMediaTime, startLocation,
 * deltaLocation, startWallclock, deltaWallclock]`.
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
 * Media time (milliseconds) of a group's first entry per the template, or
 * `null` when the template's group stride is zero (object-indexed
 * templates need object-level resolution the caller must do itself), the
 * group precedes the template start, or the group falls between stride
 * entries (no template entry exists for it).
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
 * The first group at which a make-before-break track switch may land.
 * MSF time-aligns alternate-group tracks at equal group numbers, and a
 * group always starts with a random-access point — so the earliest clean
 * handoff is the next group after the one currently rendering.
 */
export function nextSwitchGroup(currentGroupId: number): number {
  return currentGroupId + 1;
}

/**
 * Whether a switch from `fromTrackAltGroup` to `toTrackAltGroup` can rely
 * on group-number alignment (§4.2: tracks in a common alternate group
 * MUST be time-aligned). `undefined` alt groups never align.
 */
export function isTimeAligned(fromAltGroup: number | undefined, toAltGroup: number | undefined): boolean {
  return fromAltGroup !== undefined && fromAltGroup === toAltGroup;
}

// ============================================================================
// Live-edge / latency math
// ============================================================================

/**
 * Glass-to-glass latency estimate in seconds for a frame whose LOC
 * timestamp is wallclock-anchored (no timescale ⇒ microseconds since the
 * Unix epoch): how far behind "now" the frame was captured.
 */
export function estimateLatencySeconds(frameTimestampUs: number, nowEpochMs: number): number {
  return nowEpochMs / 1000 - frameTimestampUs / MICROSECONDS_PER_SECOND;
}

/**
 * Jitter-buffer depth in seconds between the newest buffered frame and
 * the frame currently being played out.
 */
export function bufferDepthSeconds(newestTimestampUs: number, playoutTimestampUs: number): number {
  return Math.max(0, (newestTimestampUs - playoutTimestampUs) / MICROSECONDS_PER_SECOND);
}
