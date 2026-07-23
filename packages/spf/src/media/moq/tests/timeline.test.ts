import { describe, expect, it } from 'vitest';
import {
  bufferDepthSeconds,
  estimateLatencySeconds,
  isTimeAligned,
  nextSwitchGroup,
  parseMediaTimelineTemplate,
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
