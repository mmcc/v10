# Vendored MoQ specifications

Verbatim IETF Internet-Draft texts for the protocols the MoQ stack in `packages/spf` implements. They are vendored so reviewers and agents can cite sections without network access, and so a revision bump is a reviewable diff.

The version the code actually speaks is declared in code: `MOQT_PROTOCOL_ID` in `packages/spf/src/network/moqt/control-messages.ts` for the transport, and the header comments of `packages/spf/src/media/moq/loc.ts` and `parse-catalog.ts` for LOC and MSF. When the vendored text is newer than the code pin, the gap is tracked by a migration plan under `.agents/plans/`.

| Draft | Revision | Published | Implemented in |
| --- | --- | --- | --- |
| Media over QUIC Transport | `draft-ietf-moq-transport-20` | 2026-08-31 | `packages/spf/src/network/moqt/` |
| Low Overhead Media Container (LOC) | `draft-ietf-moq-loc-04` | 2026-07-20 | `packages/spf/src/media/moq/loc.ts` |
| MOQT Streaming Format (MSF) | `draft-ietf-moq-msf-01` | 2026-06-02 | `packages/spf/src/media/moq/parse-catalog.ts`, `parse-source.ts` |

## Provenance

Fetched 2026-09-02 from the IETF archive at `https://www.ietf.org/archive/id/<draft-name>.txt`, unmodified.

| File | SHA-256 |
| --- | --- |
| `draft-ietf-moq-transport-20.txt` | `96a3a4467da53cd71bb4d1c334ac7ab13887f02b2e27335e715f75889fa9a1c6` |
| `draft-ietf-moq-loc-04.txt` | `fb29e2805be0511a188683b60fc830fb7fd3ecf19931968755d60d83707c3b47` |
| `draft-ietf-moq-msf-01.txt` | `c3e68aac09c36ae1db4afde6fd0600a949e7265348f592520304a31e993c35af` |

Working-group sources: [moq-wg/moq-transport](https://github.com/moq-wg/moq-transport), [moq-wg/loc](https://github.com/moq-wg/loc), [moq-wg/msf](https://github.com/moq-wg/msf). Each transport revision carries a change log in Appendix A; a rendered diff against the prior revision is available at `https://author-tools.ietf.org/iddiff?url1=<old>&url2=<new>`.

## Updating a draft

1. Download the new `.txt` from the IETF archive into this directory and delete the superseded revision.
2. Update the tables above (revision, date, checksum).
3. Either update the code pin and its section citations in the same change, or write the migration plan under `.agents/plans/` and link it from the commit.
