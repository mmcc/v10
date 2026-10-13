/**
 * H.264 codec-string derivation for the publish-direction catalog.
 *
 * `avc1` and `avc3` are contracts, not stylistic variants (ISO/IEC 14496-15): `avc1` promises a length-prefixed
 * bitstream whose parameter sets live out-of-band, `avc3` in-band parameter sets. In an MSF catalog the codec string is
 * the only place that distinction — and the stream's actual profile/level — is expressed, so it must describe the
 * bitstream as published, not as requested.
 */

/**
 * The `avc1.PPCCLL` codec string an avcC declares, or `undefined` when the bytes are not an
 * AVCDecoderConfigurationRecord (wrong version or truncated). Bytes 1–3 of the record are AVCProfileIndication,
 * profile_compatibility, and AVCLevelIndication — the exact triple the codec-string suffix encodes (RFC 6381 §3.3) —
 * and the encoder builds them from the SPS it actually emitted, so the derived string tracks the wire where the
 * requested config's suffix may not: an encoder may honor the requested profile yet pick its own constraint flags and
 * level.
 */
export function avcCodecFromAvcC(avcC: Uint8Array): string | undefined {
  if (avcC.length < 4 || avcC[0] !== 1) return undefined;

  const hex = (byte: number) => byte.toString(16).toUpperCase().padStart(2, '0');

  return `avc1.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}
