import { describe, expect, it } from 'vitest';
import { avcCodecFromAvcC } from '../avc-codec';

describe('avcCodecFromAvcC', () => {
  it('derives the codec string from the record’s profile, compatibility, and level bytes', () => {
    // Baseline (0x42), constraint flags 0xC0, level 3.0 (0x1E) — the
    // triple issue #23 measured on the wire while the requested config
    // said 42E01F.
    const avcC = Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff, 0xe1]);
    expect(avcCodecFromAvcC(avcC)).toBe('avc1.42C01E');
  });

  it('zero-pads and uppercases each byte of the suffix', () => {
    const avcC = Uint8Array.from([0x01, 0x64, 0x00, 0x0a]);
    expect(avcCodecFromAvcC(avcC)).toBe('avc1.64000A');
  });

  it('rejects bytes whose configurationVersion is not 1', () => {
    expect(avcCodecFromAvcC(Uint8Array.from([0x00, 0x42, 0xc0, 0x1e]))).toBeUndefined();
  });

  it('rejects a record too short to carry the profile/level triple', () => {
    expect(avcCodecFromAvcC(Uint8Array.from([0x01, 0x42, 0xc0]))).toBeUndefined();
  });
});
