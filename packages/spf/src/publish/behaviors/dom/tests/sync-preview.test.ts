import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import { type SyncPreviewContext, syncPreview } from '../sync-preview';

function makeContext(initial: SyncPreviewContext = {}): ContextSignals<SyncPreviewContext> {
  return {
    previewElement: signal(initial.previewElement),
    captureStream: signal(initial.captureStream),
  };
}

function makePreviewElement(): HTMLVideoElement {
  const element = document.createElement('video');
  // A real play() on a raw MediaStream pends forever in headless — the
  // behavior treats it fire-and-forget, so a resolved spy keeps tests fast.
  vi.spyOn(element, 'play').mockResolvedValue(undefined);
  return element;
}

describe('syncPreview', () => {
  let context: ContextSignals<SyncPreviewContext>;
  let cleanup: () => void;

  beforeEach(() => {
    context = makeContext();
    cleanup = syncPreview.setup({ context });
    return () => cleanup();
  });

  it('mirrors the stream into the preview element (muted, inline, playing)', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();

    context.previewElement.set(element);
    context.captureStream.set(stream);

    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });
    expect(element.muted).toBe(true);
    expect(element.playsInline).toBe(true);
    expect(element.play).toHaveBeenCalled();
  });

  it('clears srcObject when the stream goes away', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();
    context.previewElement.set(element);
    context.captureStream.set(stream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });

    context.captureStream.set(undefined);

    await vi.waitFor(() => {
      expect(element.srcObject).toBeNull();
    });
  });

  it('clears the old element and wires the new one on element swap', async () => {
    const first = makePreviewElement();
    const second = makePreviewElement();
    const stream = new MediaStream();
    context.previewElement.set(first);
    context.captureStream.set(stream);
    await vi.waitFor(() => {
      expect(first.srcObject).toBe(stream);
    });

    context.previewElement.set(second);

    await vi.waitFor(() => {
      expect(second.srcObject).toBe(stream);
    });
    expect(first.srcObject).toBeNull();
  });

  it('cleanup clears the preview wiring', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();
    context.previewElement.set(element);
    context.captureStream.set(stream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });

    cleanup();

    expect(element.srcObject).toBeNull();
  });

  it('leaves an externally replaced srcObject alone', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();
    context.previewElement.set(element);
    context.captureStream.set(stream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });

    const external = new MediaStream();
    element.srcObject = external;
    context.captureStream.set(undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.srcObject).toBe(external);
  });
});
