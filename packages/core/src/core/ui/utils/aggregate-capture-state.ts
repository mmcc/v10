import type { MediaCaptureState } from '@videojs/media';

/**
 * Aggregate the camera and screen-share pipelines' independent lifecycles
 * into the one status a capture-gated control reacts to: active if either
 * source is, else the more "in-progress" of the two — `acquiring` >
 * `denied` > `ended` > `idle` — matching the precedence a single exclusive
 * source used to have before capture became additive.
 */
const STATUS_PRECEDENCE: readonly MediaCaptureState[] = ['active', 'acquiring', 'denied', 'ended', 'idle'];

export function aggregateCaptureState(camera: MediaCaptureState, screen: MediaCaptureState): MediaCaptureState {
  return STATUS_PRECEDENCE.find((status) => status === camera || status === screen) ?? 'idle';
}
