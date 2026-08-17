/**
 * MSF catalog building (draft-ietf-moq-msf-01 §5) — the publish-direction
 * complement to `parse-catalog.ts`.
 *
 * Emits the independent-catalog JSON a publisher sends as object 0 of a
 * new group on its catalog track. The output is deliberately the exact
 * dialect `parse-catalog.ts` consumes — every emitted document must
 * round-trip through `applyMoqCatalogUpdate` + `moqCatalogToPresentation`
 * into tracks `codec-mapping.ts` can configure decoders from; that
 * round-trip is the module's acceptance test.
 *
 * One LOC-packaged camera video rendition, an optional second
 * LOC-packaged screen-share video rendition (additive, not an alternate —
 * see the multi-source design record), plus one LOC-packaged audio track.
 * When a screen track is present, all tracks share one `renderGroup` (never
 * `altGroup`, which marks alternates of the same content) so subscribers
 * know camera + screen + audio compose one live view; a camera-only
 * catalog stays exactly as it was before screen share existed. The absent
 * `altGroup` is the load-bearing half of that pair on the parse side: it is
 * what puts camera and screen in separate switching sets, so a subscriber's
 * ABR never mistakes the screen share for a cheaper camera. Codec
 * strings are WebCodecs registry strings (§5.2.18) and pass through
 * verbatim — the caller resolves what to declare (`derive-catalog.ts`
 * re-derives H.264 strings from the published bitstream). A track's
 * decoder init
 * data (`initData`) is emitted as an inline `initDataList` entry plus a
 * per-track `initRef` (§5.2.16-17) — the catalog is the one channel every
 * consumer can read: LOC's per-keyframe Config property (`loc-packaging.ts`)
 * is an odd-id MOQ object property that relays and non-SPF consumers drop
 * without surfacing, so it is carried as a refresh bonus, never the only
 * copy.
 */

/** Version emitted — the newest version `parse-catalog.ts` accepts. */
export const MSF_CATALOG_VERSION = 'draft-01';

export interface MsfCatalogVideoTrackInput {
  name: string;
  /** WebCodecs registry codec string, e.g. `'avc1.42E01F'` or `'vp8'`. */
  codec: string;
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: number;
  /**
   * Decoder init data (WebCodecs `decoderConfig.description`, e.g. avcC
   * for `avc`-format H.264) — emitted as an inline `initDataList` entry
   * referenced by the track's `initRef`.
   */
  initData?: Uint8Array;
}

export interface MsfCatalogAudioTrackInput {
  name: string;
  /** WebCodecs registry codec string, e.g. `'opus'`. */
  codec: string;
  /** Output sample rate (§5.2.20). */
  samplerate?: number;
  /** Channel config string (§5.2.21), e.g. `'2'` or `'5.1'`. */
  channelConfig?: string;
  bitrate?: number;
  /** Decoder init data, e.g. an AAC AudioSpecificConfig — Opus carries none. */
  initData?: Uint8Array;
}

export interface MsfCatalogInput {
  /** Track namespace tuple every track is published under. */
  namespace: readonly string[];
  video?: MsfCatalogVideoTrackInput;
  /** Screen-share video track — additive alongside `video`, never an alternate. */
  screen?: MsfCatalogVideoTrackInput;
  audio?: MsfCatalogAudioTrackInput;
  /** Catalog generation time (§5.2.24), epoch milliseconds. */
  generatedAt?: number;
}

/** The `buildCatalog` config seam's shape. */
export type BuildMsfCatalog = (input: MsfCatalogInput) => string;

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/** Inverse of `parse-catalog.ts`'s `base64ToBytes`. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** One inline `initDataList` entry (§5.2.16). */
interface MsfInitDataEntry {
  id: string;
  type: 'inline';
  data: string;
}

/**
 * Register a track's init data and return the `initRef` naming it. Ids
 * derive from the track name, which is unique within the catalog.
 */
function registerInitData(entries: MsfInitDataEntry[], name: string, initData: Uint8Array | undefined) {
  if (initData === undefined) return {};
  const id = `${name}-init`;
  entries.push({ id, type: 'inline', data: bytesToBase64(initData) });
  return { initRef: id };
}

/**
 * Build the publisher's independent MSF catalog JSON.
 *
 * Namespaces are emitted explicitly per track as the path-joined string
 * form `parse-catalog.ts` splits back into tuple fields — the same
 * (interop-pending) encoding the parser assumes, so the pair stays
 * self-consistent whatever the drafts settle on.
 */
export function buildMsfCatalog(input: MsfCatalogInput): string {
  const namespace = input.namespace.join('/');
  const shared = { namespace, packaging: 'loc', isLive: true };
  // Only grouped once a screen track exists — a camera-only catalog stays
  // byte-identical to before screen share existed.
  const renderGroup = input.screen ? { renderGroup: 1 } : {};

  const initDataList: MsfInitDataEntry[] = [];
  const tracks: Record<string, unknown>[] = [];
  if (input.video) {
    tracks.push(
      pruneUndefined({
        ...shared,
        ...renderGroup,
        ...registerInitData(initDataList, input.video.name, input.video.initData),
        name: input.video.name,
        role: 'video',
        codec: input.video.codec,
        width: input.video.width,
        height: input.video.height,
        framerate: input.video.framerate,
        bitrate: input.video.bitrate,
      })
    );
  }
  if (input.screen) {
    tracks.push(
      pruneUndefined({
        ...shared,
        ...renderGroup,
        ...registerInitData(initDataList, input.screen.name, input.screen.initData),
        name: input.screen.name,
        role: 'video',
        codec: input.screen.codec,
        width: input.screen.width,
        height: input.screen.height,
        framerate: input.screen.framerate,
        bitrate: input.screen.bitrate,
      })
    );
  }
  if (input.audio) {
    tracks.push(
      pruneUndefined({
        ...shared,
        ...renderGroup,
        ...registerInitData(initDataList, input.audio.name, input.audio.initData),
        name: input.audio.name,
        role: 'audio',
        codec: input.audio.codec,
        samplerate: input.audio.samplerate,
        channelConfig: input.audio.channelConfig,
        bitrate: input.audio.bitrate,
      })
    );
  }

  return JSON.stringify(
    pruneUndefined({
      version: MSF_CATALOG_VERSION,
      generatedAt: input.generatedAt,
      isComplete: true,
      tracks,
      initDataList: initDataList.length > 0 ? initDataList : undefined,
    })
  );
}
