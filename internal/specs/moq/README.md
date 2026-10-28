# Vendored MoQ specifications

Verbatim IETF Internet-Draft texts for the protocols the MoQ stack in `packages/spf` implements. They are vendored so reviewers and agents can cite sections without network access, and so a revision bump is a reviewable diff.

For a complete catalog example and the current player's media requirements, see [Publish a stream for the MoQ player](../../../packages/spf/docs/moq-publishing.md).

The version the code actually speaks is declared in code: the transport comes from the `@caprid/moq-core` dependency of `packages/spf` (its `MOQT_PROTOCOL_IDS` lists the versions the player and the publisher offer, most preferred first; `moqt-20` is the fallback), and the header comments of `packages/spf/src/media/moq/loc.ts` and `parse-catalog.ts` for LOC and MSF. When the vendored text is newer than the code pin, the gap is tracked by a migration plan under `.agents/plans/`.

| Draft | Revision | Published | Implemented in |
| --- | --- | --- | --- |
| Media over QUIC Transport | `draft-ietf-moq-transport-22` | 2026-10-01 | `@caprid/moq-core`, consumed by `packages/spf/src/playback/actors/moq-session.ts` and `packages/spf/src/publish/session/publish-session.ts` |
| Low Overhead Media Container (LOC) | `draft-ietf-moq-loc-04` | 2026-07-20 | `packages/spf/src/media/moq/loc.ts` |
| MOQT Streaming Format (MSF) | `draft-ietf-moq-msf-01` | 2026-06-02 | `packages/spf/src/media/moq/parse-catalog.ts`, `parse-source.ts` |

## Provenance

Fetched from the IETF archive at `https://www.ietf.org/archive/id/<draft-name>.txt`, unmodified: the transport draft on 2026-10-27, LOC and MSF on 2026-09-02.

| File | SHA-256 |
| --- | --- |
| `draft-ietf-moq-transport-22.txt` | `1a725f10db526d94f915b30db9004821d86e57afcdde10789c54fee64b3056b5` |
| `draft-ietf-moq-loc-04.txt` | `fb29e2805be0511a188683b60fc830fb7fd3ecf19931968755d60d83707c3b47` |
| `draft-ietf-moq-msf-01.txt` | `c3e68aac09c36ae1db4afde6fd0600a949e7265348f592520304a31e993c35af` |

Working-group sources: [moq-wg/moq-transport](https://github.com/moq-wg/moq-transport), [moq-wg/loc](https://github.com/moq-wg/loc), [moq-wg/msf](https://github.com/moq-wg/msf). Each transport revision carries a change log in Appendix A; a rendered diff against the prior revision is available at `https://author-tools.ietf.org/iddiff?url1=<old>&url2=<new>`.

## Updating a draft

1. Download the new `.txt` from the IETF archive into this directory and delete the superseded revision.
2. Update the tables above (revision, date, checksum).
3. Either update the code pin and its section citations in the same change, or write the migration plan under `.agents/plans/` and link it from the commit.
