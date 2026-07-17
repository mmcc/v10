import { describe, expect, it } from 'vitest';
import { LOC_PROPERTY, locTimestampToMicroseconds, parseLocProperties, toLocFrame } from '../loc';

describe('parseLocProperties', () => {
  it('extracts timestamp, timescale, and video config', () => {
    const config = new Uint8Array([1, 100, 0, 31]);
    const parsed = parseLocProperties([
      { type: LOC_PROPERTY.TIMESTAMP, value: 90_000 },
      { type: LOC_PROPERTY.TIMESCALE, value: 90_000 },
      { type: LOC_PROPERTY.VIDEO_CONFIG, value: config },
    ]);
    expect(parsed).toEqual({ timestamp: 90_000, timescale: 90_000, videoConfig: config });
  });

  it('ignores unknown properties', () => {
    expect(parseLocProperties([{ type: 0x7a, value: 5 }])).toEqual({});
  });
});

describe('locTimestampToMicroseconds', () => {
  it('passes microsecond timestamps through when no timescale is set', () => {
    expect(locTimestampToMicroseconds(1_700_000_000_000_000)).toBe(1_700_000_000_000_000);
  });

  it('rescales timescale-based timestamps', () => {
    expect(locTimestampToMicroseconds(90_000, 90_000)).toBe(1_000_000); // one second
    expect(locTimestampToMicroseconds(48_000, 48_000)).toBe(1_000_000);
    expect(locTimestampToMicroseconds(1, 1_000_000)).toBe(1);
  });
});

describe('toLocFrame', () => {
  const payload = new Uint8Array([9, 9, 9]);

  it('builds a frame with the group-start keyframe rule', () => {
    const key = toLocFrame({ objectId: 0, properties: [{ type: LOC_PROPERTY.TIMESTAMP, value: 5 }], payload });
    const delta = toLocFrame({ objectId: 3, properties: [{ type: LOC_PROPERTY.TIMESTAMP, value: 6 }], payload });
    expect(key).toMatchObject({ isKey: true, timestampUs: 5, payload });
    expect(delta).toMatchObject({ isKey: false, timestampUs: 6 });
  });

  it('uses the catalog timescale when the object carries none', () => {
    const frame = toLocFrame(
      { objectId: 0, properties: [{ type: LOC_PROPERTY.TIMESTAMP, value: 90_000 }], payload },
      { timescale: 90_000 }
    );
    expect(frame?.timestampUs).toBe(1_000_000);
  });

  it('prefers the object timescale over the catalog timescale', () => {
    const frame = toLocFrame(
      {
        objectId: 0,
        properties: [
          { type: LOC_PROPERTY.TIMESTAMP, value: 48_000 },
          { type: LOC_PROPERTY.TIMESCALE, value: 48_000 },
        ],
        payload,
      },
      { timescale: 90_000 }
    );
    expect(frame?.timestampUs).toBe(1_000_000);
  });

  it('returns null for payload-less or timestamp-less objects', () => {
    expect(toLocFrame({ objectId: 0, properties: [], payload: new Uint8Array(0) })).toBeNull();
    expect(toLocFrame({ objectId: 0, properties: [], payload })).toBeNull();
  });
});
