import { describe, expect, it } from 'vite-plus/test';

import {
  bufferDepthSeconds,
  estimateLatencySeconds,
  isTimeAligned,
  joinAnchorUs,
  nextSwitchGroup,
  parseMediaTimelineTemplate,
  preferredTargetLatencySeconds,
  resolveTargetLatencySeconds,
  templateGroupForMediaTime,
  templateMediaTimeForGroup,
} from '../timeline';

// The msf-01 §7.4.1 example template.
const SPEC_TEMPLATE = [0, 2002, [0, 0], [1, 0], 1759924158381, 2002];

describe('parseMediaTimelineTemplate', () => {
  it('parses the spec example', () => {
    expect(parseMediaTimelineTemplate(SPEC_TEMPLATE)).toEqual({
      startMediaTime: 0,
      deltaMediaTime: 2002,
      startLocation: { group: 0, object: 0 },
      deltaLocation: { group: 1, object: 0 },
      startWallclock: 1759924158381,
      deltaWallclock: 2002,
    });
  });

  it('returns null for malformed templates', () => {
    expect(parseMediaTimelineTemplate(null)).toBeNull();
    expect(parseMediaTimelineTemplate([0, 2002])).toBeNull();
    expect(parseMediaTimelineTemplate([0, 2002, 'x', [1, 0], 0, 0])).toBeNull();
  });
});

describe('templateMediaTimeForGroup', () => {
  const template = parseMediaTimelineTemplate(SPEC_TEMPLATE)!;

  it('computes mediaTime[n] = start + n * delta', () => {
    expect(templateMediaTimeForGroup(template, 0)).toBe(0);
    expect(templateMediaTimeForGroup(template, 10)).toBe(20_020);
  });

  it('returns null before the template start or for object-indexed templates', () => {
    expect(templateMediaTimeForGroup(template, -1)).toBeNull();
    const objectIndexed = parseMediaTimelineTemplate([0, 20, [0, 0], [0, 1], 0, 0])!;

    expect(templateMediaTimeForGroup(objectIndexed, 5)).toBeNull();
  });

  it('returns null for groups between stride entries', () => {
    const strided = parseMediaTimelineTemplate([0, 2002, [0, 0], [2, 0], 0, 0])!;

    expect(templateMediaTimeForGroup(strided, 3)).toBeNull();
    expect(templateMediaTimeForGroup(strided, 4)).toBe(4004);
  });
});

describe('templateGroupForMediaTime', () => {
  const template = parseMediaTimelineTemplate(SPEC_TEMPLATE)!;

  it('inverts the mapping (floor to the covering entry)', () => {
    expect(templateGroupForMediaTime(template, 0)).toBe(0);
    expect(templateGroupForMediaTime(template, 2001)).toBe(0);
    expect(templateGroupForMediaTime(template, 2002)).toBe(1);
    expect(templateGroupForMediaTime(template, 20_020)).toBe(10);
  });

  it('returns null for times before the start', () => {
    expect(templateGroupForMediaTime(template, -5)).toBeNull();
  });
});

describe('nextSwitchGroup', () => {
  it('is the next group boundary (groups start with a random-access point)', () => {
    expect(nextSwitchGroup(41)).toBe(42);
  });
});

describe('isTimeAligned', () => {
  it('aligns only tracks sharing an alternate group', () => {
    expect(isTimeAligned(1, 1)).toBe(true);
    expect(isTimeAligned(1, 2)).toBe(false);
    expect(isTimeAligned(undefined, undefined)).toBe(false);
  });
});

describe('estimateLatencySeconds', () => {
  it('measures capture-to-now distance for wallclock-anchored timestamps', () => {
    const nowMs = 1_700_000_001_000;
    const capturedUs = 1_700_000_000_000_000; // one second earlier

    expect(estimateLatencySeconds(capturedUs, nowMs)).toBeCloseTo(1);
  });
});

describe('bufferDepthSeconds', () => {
  it('measures newest-minus-playout and clamps at zero', () => {
    expect(bufferDepthSeconds(2_000_000, 500_000)).toBeCloseTo(1.5);
    expect(bufferDepthSeconds(500_000, 2_000_000)).toBe(0);
  });
});

describe('preferredTargetLatencySeconds', () => {
  // The whole additive contract in one function: adaptation can only ever
  // fill in where the consumer stated nothing, and with neither stated the
  // catalog → default chain below it sees exactly what it always saw.
  it('lets an explicit consumer target beat the adaptive proposal', () => {
    expect(preferredTargetLatencySeconds(2, 0.3)).toBe(2);
    expect(preferredTargetLatencySeconds(undefined, 0.3)).toBe(0.3);
    expect(preferredTargetLatencySeconds(2, undefined)).toBe(2);
    expect(preferredTargetLatencySeconds(undefined, undefined)).toBeUndefined();
  });

  // Precedence is by usability, not presence: a consumer target nothing can
  // hold must not shadow a proposal that can be held.
  it('does not let an unusable consumer target shadow the adaptive proposal', () => {
    expect(preferredTargetLatencySeconds(Number.NaN, 0.3)).toBe(0.3);
    expect(preferredTargetLatencySeconds(-1, 0.3)).toBe(0.3);
    expect(preferredTargetLatencySeconds(0, 0.3)).toBe(0.3);
    expect(preferredTargetLatencySeconds(Number.POSITIVE_INFINITY, 0.3)).toBe(0.3);
    expect(preferredTargetLatencySeconds(Number.NaN, undefined)).toBeUndefined();
    expect(preferredTargetLatencySeconds(Number.NaN, -1)).toBeUndefined();
  });
});

describe('resolveTargetLatencySeconds', () => {
  it('resolves consumer, then catalog milliseconds, then the default', () => {
    expect(resolveTargetLatencySeconds(2, 300, 0.5)).toBe(2);
    expect(resolveTargetLatencySeconds(undefined, 300, 0.5)).toBeCloseTo(0.3);
    expect(resolveTargetLatencySeconds(undefined, undefined, 0.5)).toBe(0.5);
  });

  // A resolved `NaN` propagates through `joinAnchorUs` into the video
  // self-clock's slew, which writes the corrected value back as its own
  // anchor — one read leaves the clock permanently `NaN` and no frame is
  // ever due again. A zero or negative target anchors playout at or past
  // the delivery edge, where both renderers discard everything they hold.
  it('skips a layer that states something no clock can hold', () => {
    expect(resolveTargetLatencySeconds(Number.NaN, 300, 0.5)).toBeCloseTo(0.3);
    expect(resolveTargetLatencySeconds(-1, 300, 0.5)).toBeCloseTo(0.3);
    expect(resolveTargetLatencySeconds(0, 300, 0.5)).toBeCloseTo(0.3);
    // The catalog is a remote publisher's number and the one layer nothing
    // else validates, so it is skipped on the same rule.
    expect(resolveTargetLatencySeconds(undefined, Number.NaN, 0.5)).toBe(0.5);
    expect(resolveTargetLatencySeconds(undefined, -300, 0.5)).toBe(0.5);
    expect(resolveTargetLatencySeconds(undefined, 0, 0.5)).toBe(0.5);
    expect(resolveTargetLatencySeconds(Number.NaN, Number.NaN, 0.5)).toBe(0.5);
  });

  // The renderers' whole use of the resolved target: a finite anchor is
  // what keeps the self-clock finite.
  it('resolves to a target that keeps the join anchor finite', () => {
    const newestUs = 10_000_000;

    expect(joinAnchorUs(newestUs, resolveTargetLatencySeconds(Number.NaN, undefined, 0.5))).toBe(9_500_000);
    expect(Number.isFinite(joinAnchorUs(newestUs, resolveTargetLatencySeconds(Number.NaN, Number.NaN, 0.5)))).toBe(
      true
    );
  });
});
