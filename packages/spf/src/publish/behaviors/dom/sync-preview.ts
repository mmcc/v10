/**
 * **Mirror one capture stream into the preview element.** While `context.previewElement` is present and
 * `state.previewSource` names a stream that is itself present (`context.cameraStream` / `context.screenStream`), sets
 * the element's `srcObject` to that stream, forces `muted` + `playsInline` (local monitors must never echo the
 * microphone or block on autoplay policy), and kicks off a fire-and-forget `play()`.
 *
 * V1 ships one switchable preview, not dual slots — see the multi-source design record's "Preview" decision.
 * `previewSource` picks a specific stream; it does not fall back to whichever source happens to be live.
 *
 * Simple single-effect behavior. The effect's cleanup clears `srcObject` from exactly the element/stream pair it wired
 * — so a source switch, a stream release, an element swap, a detach, or behavior teardown all clear the old preview
 * structurally before (or without) a new pairing.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import type { ReadonlySignal } from '../../../core/signals/primitives';

export type PreviewSource = 'camera' | 'screen';

export interface SyncPreviewState {
  /** Which capture stream the preview element mirrors. Defaults to `'camera'`. */
  previewSource?: PreviewSource;
}

export interface SyncPreviewContext {
  previewElement?: HTMLVideoElement | undefined;
  cameraStream?: MediaStream | undefined;
  screenStream?: MediaStream | undefined;
}

function syncPreviewSetup({
  state,
  context,
}: {
  state: {
    previewSource: ReadonlySignal<SyncPreviewState['previewSource']>;
  };
  context: {
    previewElement: ReadonlySignal<SyncPreviewContext['previewElement']>;
    cameraStream: ReadonlySignal<SyncPreviewContext['cameraStream']>;
    screenStream: ReadonlySignal<SyncPreviewContext['screenStream']>;
  };
}): () => void {
  return effect(() => {
    const element = context.previewElement.get();
    const source = state.previewSource.get() ?? 'camera';
    const stream = source === 'screen' ? context.screenStream.get() : context.cameraStream.get();
    if (!element || !stream) return;

    element.srcObject = stream;
    element.muted = true;
    element.playsInline = true;
    element.play().catch(() => undefined);

    return () => {
      // Only clear our own wiring — a newer pairing (or external code) may
      // already have replaced `srcObject` by the time this cleanup runs.
      if (element.srcObject === stream) element.srcObject = null;
    };
  });
}

export const syncPreview = defineBehavior({
  stateKeys: ['previewSource'],
  contextKeys: ['previewElement', 'cameraStream', 'screenStream'],
  setup: syncPreviewSetup,
});
