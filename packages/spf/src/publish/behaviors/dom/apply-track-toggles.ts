/**
 * **Apply the mute toggles to the live capture tracks.** Continuously
 * syncs `state.cameraMuted` / `state.micMuted` onto `track.enabled` of the
 * capture stream's video/audio tracks — a disabled track keeps capturing
 * but produces black frames / silence, so muting never tears the pipeline
 * down. Reading both the stream and the flags in one effect means a newly
 * acquired stream gets the current mute state applied on arrival.
 *
 * Simple single-effect behavior; no cleanup beyond the effect itself —
 * track state dies with the stream, which `acquireCaptureSource` owns.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import type { ReadonlySignal } from '../../../core/signals/primitives';

/**
 * State shape for capture-track mute toggles.
 */
export interface ApplyTrackTogglesState {
  /** Mute outgoing video (track disabled, capture keeps running). */
  cameraMuted?: boolean;
  /** Mute outgoing audio (track disabled, capture keeps running). */
  micMuted?: boolean;
}

/**
 * Context shape for capture-track mute toggles.
 */
export interface ApplyTrackTogglesContext {
  captureStream?: MediaStream | undefined;
}

function applyTrackTogglesSetup({
  state,
  context,
}: {
  state: {
    cameraMuted: ReadonlySignal<ApplyTrackTogglesState['cameraMuted']>;
    micMuted: ReadonlySignal<ApplyTrackTogglesState['micMuted']>;
  };
  context: {
    captureStream: ReadonlySignal<ApplyTrackTogglesContext['captureStream']>;
  };
}): () => void {
  return effect(() => {
    const stream = context.captureStream.get();
    const cameraMuted = state.cameraMuted.get() ?? false;
    const micMuted = state.micMuted.get() ?? false;
    if (!stream) return;

    for (const track of stream.getVideoTracks()) track.enabled = !cameraMuted;
    for (const track of stream.getAudioTracks()) track.enabled = !micMuted;
  });
}

export const applyTrackToggles = defineBehavior({
  stateKeys: ['cameraMuted', 'micMuted'],
  contextKeys: ['captureStream'],
  setup: applyTrackTogglesSetup,
});
