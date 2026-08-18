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
 * status a capture-gated control reacts to. The mic's in-flight states
 * count only under explicit `micActive` — the same rule the publish engine
 * applies to its session gate: an implied mic (acquired as a side effect
 * of video intent) reporting `active` must not enable publish controls the
 * video pipelines no longer justify, e.g. a mic that outlives a dismissed
 * screen picker by a beat. Its terminal states (`denied`/`ended`) count
 * even with the intent consumed: the acquire pipeline consumes `micActive`
 * on those outcomes while parking the state precisely so UIs can keep
 * saying why capture stopped — and neither can enable a publish control.
 */
export function aggregateCaptureState(source: AggregatableCaptureSource): MediaCaptureState {
  const micCounts = source.micActive || source.micState === 'denied' || source.micState === 'ended';
  const micState = micCounts ? source.micState : 'idle';
  return (
    STATUS_PRECEDENCE.find(
      (status) => status === source.cameraState || status === source.screenShareState || status === micState
    ) ?? 'idle'
  );
}
