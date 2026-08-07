/**
 * **Apply the mute toggles to the live capture tracks.** Continuously
 * syncs `state.cameraMuted` onto `context.cameraStream`'s video track and
 * `state.micMuted` onto `context.micStream`'s audio track — a disabled
 * track keeps capturing but produces black frames / silence, so muting
 * never tears a pipeline down. Screen share has no mute of its own in v1
 * (stopping the share is the toggle). Reading both a stream and its flag
 * in one effect means a newly acquired stream gets the current mute state
 * applied on arrival.
 *
 * Two independent single-effect sub-behaviors (one per source); no
 * cleanup beyond the effect itself — track state dies with the stream,
 * which the acquire behaviors own.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import type { ReadonlySignal } from '../../../core/signals/primitives';

export interface ApplyTrackTogglesState {
  /** Mute outgoing camera video (track disabled, capture keeps running). */
  cameraMuted?: boolean;
  /** Mute outgoing microphone audio (track disabled, capture keeps running). */
  micMuted?: boolean;
}

export interface ApplyTrackTogglesContext {
  cameraStream?: MediaStream | undefined;
  micStream?: MediaStream | undefined;
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
    cameraStream: ReadonlySignal<ApplyTrackTogglesContext['cameraStream']>;
    micStream: ReadonlySignal<ApplyTrackTogglesContext['micStream']>;
  };
}): () => void {
  const disposers = [
    effect(() => {
      const stream = context.cameraStream.get();
      const muted = state.cameraMuted.get() ?? false;
      if (!stream) return;
      for (const track of stream.getVideoTracks()) track.enabled = !muted;
    }),
    effect(() => {
      const stream = context.micStream.get();
      const muted = state.micMuted.get() ?? false;
      if (!stream) return;
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export const applyTrackToggles = defineBehavior({
  stateKeys: ['cameraMuted', 'micMuted'],
  contextKeys: ['cameraStream', 'micStream'],
  setup: applyTrackTogglesSetup,
});
