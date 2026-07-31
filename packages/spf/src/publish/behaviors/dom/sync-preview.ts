/**
 * **Mirror the capture stream into the preview element.** While both
 * `context.previewElement` and `context.captureStream` are present, sets
 * the element's `srcObject` to the stream, forces `muted` + `playsInline`
 * (local monitors must never echo the microphone or block on autoplay
 * policy), and kicks off a fire-and-forget `play()`.
 *
 * Simple single-effect behavior. The effect's cleanup clears `srcObject`
 * from exactly the element/stream pair it wired — so a stream release, an
 * element swap, a detach, or behavior teardown all clear the old preview
 * structurally before (or without) a new pairing.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import type { ReadonlySignal } from '../../../core/signals/primitives';

/**
 * Context shape for preview mirroring.
 */
export interface SyncPreviewContext {
  previewElement?: HTMLVideoElement | undefined;
  captureStream?: MediaStream | undefined;
}

function syncPreviewSetup({
  context,
}: {
  context: {
    previewElement: ReadonlySignal<SyncPreviewContext['previewElement']>;
    captureStream: ReadonlySignal<SyncPreviewContext['captureStream']>;
  };
}): () => void {
  return effect(() => {
    const element = context.previewElement.get();
    const stream = context.captureStream.get();
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
  stateKeys: [],
  contextKeys: ['previewElement', 'captureStream'],
  setup: syncPreviewSetup,
});
