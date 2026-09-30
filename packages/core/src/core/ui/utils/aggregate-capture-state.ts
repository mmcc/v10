import type { MediaCaptureSourceState, MediaCaptureState } from '@videojs/media';

/**
 * Precedence for the aggregate status: active if any counted source is, else the more "in-progress" of them —
 * `acquiring` > `denied` > `ended` > `idle` — matching the precedence a single exclusive source used to have before
 * capture became additive.
 */
const STATUS_PRECEDENCE: readonly MediaCaptureState[] = ['active', 'acquiring', 'denied', 'ended', 'idle'];

/** The capture-source fields the aggregation reads. */
export type AggregatableCaptureSource = Pick<
  MediaCaptureSourceState,
  'cameraState' | 'screenShareState' | 'micState' | 'micExplicit'
>;

/**
 * Aggregate the capture pipelines' independent lifecycles into the one status a capture-gated control reacts to. The
 * mic counts only while `micExplicit` claims its lifecycle for an explicit request — the same rule the publish engine
 * applies to its session gate: an implied mic (acquired as a side effect of video intent) must not surface capture
 * feedback the video pipelines don't justify, whether an `active` that would enable publish controls (e.g. a mic
 * outliving a dismissed screen picker by a beat) or a `denied` that would blame permissions a camera-only page never
 * asked for. Keyed on `micExplicit` rather than `micActive` because the intent slot is consumed on terminal outcomes
 * while the state stays parked precisely so UIs can say why an explicit capture stopped.
 */
export function aggregateCaptureState(source: AggregatableCaptureSource): MediaCaptureState {
  const micState = source.micExplicit ? source.micState : 'idle';

  return (
    STATUS_PRECEDENCE.find(
      (status) => status === source.cameraState || status === source.screenShareState || status === micState
    ) ?? 'idle'
  );
}
