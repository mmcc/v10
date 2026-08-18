import type { MediaCaptureSourceState, MediaCaptureState } from '@videojs/media';

/**
 * Precedence for the aggregate status: active if any counted source is,
 * else the more "in-progress" of them — `acquiring` > `denied` > `ended` >
 * `idle` — matching the precedence a single exclusive source used to have
 * before capture became additive.
 */
const STATUS_PRECEDENCE: readonly MediaCaptureState[] = ['active', 'acquiring', 'denied', 'ended', 'idle'];

/** The capture-source fields the aggregation reads. */
export type AggregatableCaptureSource = Pick<
  MediaCaptureSourceState,
  'cameraState' | 'screenShareState' | 'micState' | 'micActive'
>;

/**
 * Aggregate the capture pipelines' independent lifecycles into the one
 * status a capture-gated control reacts to. The mic counts only under
 * explicit `micActive` — the same rule the publish engine applies to its
 * session gate: an implied mic (acquired as a side effect of video intent)
 * reporting `active` must not enable publish controls the video pipelines
 * no longer justify, e.g. a mic that outlives a dismissed screen picker by
 * a beat.
 */
export function aggregateCaptureState(source: AggregatableCaptureSource): MediaCaptureState {
  const micState = source.micActive ? source.micState : 'idle';
  return (
    STATUS_PRECEDENCE.find(
      (status) => status === source.cameraState || status === source.screenShareState || status === micState
    ) ?? 'idle'
  );
}
