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

  it('accepts the draft-03 timestamp id', () => {
    expect(parseLocProperties([{ type: LOC_PROPERTY.TIMESTAMP_DRAFT03, value: 42 }])).toEqual({ timestamp: 42 });
  });

  it('prefers the draft-04 timestamp when both ids are present, in either order', () => {
    const draft04 = { type: LOC_PROPERTY.TIMESTAMP, value: 100 };
    const draft03 = { type: LOC_PROPERTY.TIMESTAMP_DRAFT03, value: 7 };
    expect(parseLocProperties([draft03, draft04])).toEqual({ timestamp: 100 });
    expect(parseLocProperties([draft04, draft03])).toEqual({ timestamp: 100 });
  });

  it('ignores unknown properties', () => {
    expect(parseLocProperties([{ type: 0x7a, value: 5 }])).toEqual({});
  });

  it('ignores the Secure Objects private-properties id', () => {
    // loc-04 §3.1.3 reassigns 0x0A, which draft-03's body text used for
    // Timestamp — reading it as one would misparse encrypted metadata.
    expect(parseLocProperties([{ type: 0x0a, value: 5 }])).toEqual({});
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

  it('reads a wire property block written against either draft', () => {
    // Literal ids, not LOC_PROPERTY: these are what publishers put on the
    // wire, so the test has to fail if the constants drift.
    const draft04 = toLocFrame(
      { objectId: 0, properties: [{ type: 0x10, value: 90_000 }], payload },
      { timescale: 90_000 }
    );
    const draft03 = toLocFrame(
      { objectId: 0, properties: [{ type: 0x06, value: 90_000 }], payload },
      { timescale: 90_000 }
    );
    expect(draft04).toMatchObject({ isKey: true, timestampUs: 1_000_000, payload });
    expect(draft03).toMatchObject({ isKey: true, timestampUs: 1_000_000, payload });
  });

  it('returns null for payload-less or timestamp-less objects', () => {
    expect(toLocFrame({ objectId: 0, properties: [], payload: new Uint8Array(0) })).toBeNull();
    expect(toLocFrame({ objectId: 0, properties: [], payload })).toBeNull();
  });
});
