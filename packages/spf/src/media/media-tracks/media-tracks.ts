/**
 * Media-track translation utilities.
 *
 * Pure, DOM-free transforms from SPF's CMAF-HAM track model onto the deduped lists a media-element adapter exposes
 * (video renditions, audio tracks), plus the selection-criteria builders that turn a chosen rendition/track back into a
 * `user*TrackSelection` partial the engine's track-switching reads.
 *
 * These return SPF _model vocabulary_ (`bandwidth`, `codecs: string[]`, `frameRate` as a rational `FrameRate`); the
 * consuming adapter owns the mapping (e.g. for DOM `bandwidth` -> `bitrate`, `codecs.join(',')` -> `codec`, `name` ->
 * `label`).
 *
 * Deduplication is by _properties_, never URL, so a multi-CDN source that lists the same rendition on several hosts
 * collapses to one entry: video renditions by `width` + `height` + `bandwidth`, audio tracks by `language` + `name`.
 * The selection builders emit those same properties as the match criteria, so selecting a collapsed entry re-selects,
 * for example, every underlying per-CDN track.
 */

import type { AudioTrack, FrameRate, MaybeResolvedPresentation, VideoTrack } from '../types';
import { findTrackById, getTracksByType } from '../utils/tracks';

export type { AudioTrack, VideoTrack };

/** Properties that identify a distinct video rendition (multi-CDN copies share them). */
export interface VideoDedupeKey {
  width?: VideoTrack['width'];
  height?: VideoTrack['height'];
  bandwidth?: VideoTrack['bandwidth'];
}

/** Properties that identify a distinct audio track (multi-CDN copies share them). */
export interface AudioDedupeKey {
  language?: AudioTrack['language'];
  name?: AudioTrack['name'];
}

/**
 * The distinct video tracks of a presentation, deduped by {@link VideoDedupeKey} (first occurrence wins).
 *
 * Entries from sibling switching sets are addressable by `id` only — {@link toUserVideoTrackSelection} is
 * quality-shaped, so it cannot tell a screen share from a same-shaped camera rendition. Selecting a _content item_
 * means writing its `id` to `selectedVideoTrackId`; the quality criteria then pin the rendition within whichever set
 * that id chose.
 *
 * Returns `[]` when the presentation is unresolved or has no video tracks.
 */
export function dedupedVideoTracks(presentation: MaybeResolvedPresentation | undefined): VideoTrack[] {
  if (!presentation) return [];

  // Dedupe within each switching set, never across: sibling sets are
  // distinct content items (a MoQ publisher's camera and screen share),
  // and a screen track that happens to match a camera rendition's
  // dimensions/bitrate is not the same track. Set order (rendered set
  // first) is preserved so consumers see the default content first.
  const switchingSets = presentation.selectionSets?.find(({ type }) => type === 'video')?.switchingSets ?? [];
  const tracks: VideoTrack[] = [];

  for (const switchingSet of switchingSets) {
    tracks.push(...dedupe({ tracks: switchingSet.tracks as readonly VideoTrack[], keyFn: toUserVideoTrackSelection }));
  }

  return tracks;
}

/**
 * The distinct audio tracks of a presentation, deduped by `language` + `name` (first occurrence wins). Returns `[]`
 * when the presentation is unresolved or has no audio tracks.
 */
export function dedupedAudioTracks(presentation: MaybeResolvedPresentation | undefined): AudioTrack[] {
  if (!presentation) return [];

  return dedupe({
    tracks: getTracksByType(presentation, 'audio') as readonly AudioTrack[],
    keyFn: toUserAudioTrackSelection,
  });
}

/**
 * Find a video track by id, searching the same candidate set the engine resolves against ({@link dedupedVideoTracks}'s
 * pre-dedupe source, every switching set). Returns `undefined` when absent. This is the exact track, which may be a
 * per-CDN copy the dedupe collapsed away — for the entry to reflect as `active`, use {@link activeVideoTrack}.
 */
export function findVideoTrackById(
  presentation: MaybeResolvedPresentation | undefined,
  id: string | undefined
): VideoTrack | undefined {
  if (!presentation || !id) return undefined;

  const track = findTrackById(presentation, id);

  return track?.type === 'video' ? (track as VideoTrack) : undefined;
}

/**
 * The {@link dedupedVideoTracks} entry a resolved `selectedVideoTrackId` belongs to — the one entry a consumer should
 * reflect as `active`.
 *
 * Neither half of the lookup is enough alone. Comparing ids against the exposed list misses, because the engine may
 * resolve to a per-CDN copy the dedupe collapsed away. Comparing quality keys over-matches, because sibling switching
 * sets are different content and may hold same-shaped renditions — a screen share would light up alongside the camera.
 * So the quality key is resolved _within the id's own switching set_, which is exactly the scope
 * {@link dedupedVideoTracks} deduped in.
 *
 * Returns `undefined` when the id resolves to no video track.
 */
export function activeVideoTrack(
  presentation: MaybeResolvedPresentation | undefined,
  id: string | undefined
): VideoTrack | undefined {
  const resolved = findVideoTrackById(presentation, id);
  if (!resolved || !presentation) return undefined;

  const switchingSets = presentation.selectionSets?.find(({ type }) => type === 'video')?.switchingSets ?? [];
  const owning = switchingSets.find(({ tracks }) => tracks.some((track) => track.id === resolved.id));

  return (owning?.tracks as readonly VideoTrack[] | undefined)?.find((track) => isSameVideoTrack(track, resolved));
}

/** Audio counterpart of {@link findVideoTrackById}, for `enabled` reflection. */
export function findAudioTrackById(
  presentation: MaybeResolvedPresentation | undefined,
  id: string | undefined
): AudioTrack | undefined {
  if (!presentation || !id) return undefined;

  const track = findTrackById(presentation, id);

  return track?.type === 'audio' ? (track as AudioTrack) : undefined;
}

/**
 * Shallow-equal two key objects by their own properties. Both come from the same key builder, so they carry the same
 * keys — a one-directional scan suffices.
 */
function sameKey<K extends object>(a: K, b: K): boolean {
  for (const attr in a) {
    if (a[attr] !== b[attr]) return false;
  }

  return true;
}

/**
 * Dedupe tracks by a key function, keeping the first occurrence of each key. Keys are compared field-by-field ({@link
 * sameKey}).
 */
function dedupe<T, K extends object>({
  tracks,
  keyFn,
}: {
  tracks: readonly T[];
  keyFn: (track: T) => K | undefined;
}): T[] {
  const seen: K[] = [];
  const kept: T[] = [];

  for (const track of tracks) {
    const key = keyFn(track);
    if (!key || seen.some((other) => sameKey(other, key))) continue;

    seen.push(key);
    kept.push(track);
  }

  return kept;
}

/**
 * Build a partial video track that can be used as `userVideoTrackSelection`.
 *
 * Quality-shaped, and only that: width + height + bandwidth are exactly the properties multi-CDN copies of one
 * rendition share, which is what makes the criteria re-select all of them. The same property set makes it content-blind
 * — two switching sets can hold same-shaped renditions of different content — so this expresses "which rendition",
 * never "which content item". Content travels by track id (`selectedVideoTrackId`); see `confineToActiveSwitchingSet`,
 * which resolves the two against each other.
 */
export function toUserVideoTrackSelection<T extends VideoDedupeKey>(rendition?: T): Partial<VideoTrack> | undefined {
  return rendition ? { width: rendition.width, height: rendition.height, bandwidth: rendition.bandwidth } : undefined;
}

/** Build a partial audio track that can be used as a `userAudioTrackSelection`. */
export function toUserAudioTrackSelection<T extends AudioDedupeKey>(track?: T): Partial<AudioTrack> | undefined {
  return track ? { language: track.language, name: track.name } : undefined;
}

/** Whether two video tracks are the same by dedupe key */
export function isSameVideoTrack(a: VideoDedupeKey, b: VideoDedupeKey | undefined): boolean {
  return !!b && a.width === b.width && a.height === b.height && a.bandwidth === b.bandwidth;
}

/** Whether two audio tracks are the same by dedupe key */
export function isSameAudioTrack(a: AudioDedupeKey, b: AudioDedupeKey | undefined): boolean {
  return !!b && (a.language ?? '') === (b.language ?? '') && a.name === b.name;
}

/** Collapse a rational frame rate (numerator/denominator) to frames per second. */
export const frameRateToNumber = (frameRate: FrameRate) => {
  return frameRate.frameRateNumerator / (frameRate.frameRateDenominator ?? 1);
};
