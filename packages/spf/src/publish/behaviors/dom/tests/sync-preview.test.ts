import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { ContextSignals, StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import { type SyncPreviewContext, type SyncPreviewState, syncPreview } from '../sync-preview';

function makeState(initial: SyncPreviewState = {}): StateSignals<SyncPreviewState> {
  return {
    previewSource: signal(initial.previewSource ?? 'camera'),
  };
}

function makeContext(initial: SyncPreviewContext = {}): ContextSignals<SyncPreviewContext> {
  return {
    previewElement: signal(initial.previewElement),
    cameraStream: signal(initial.cameraStream),
    screenStream: signal(initial.screenStream),
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
  let state: StateSignals<SyncPreviewState>;
  let context: ContextSignals<SyncPreviewContext>;
  let cleanup: () => void;

  beforeEach(() => {
    state = makeState();
    context = makeContext();
    cleanup = syncPreview.setup({ state, context });
    return () => cleanup();
  });

  it('mirrors the camera stream by default (muted, inline, playing)', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();

    context.previewElement.set(element);
    context.cameraStream.set(stream);

    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });
    expect(element.muted).toBe(true);
    expect(element.playsInline).toBe(true);
    expect(element.play).toHaveBeenCalled();
  });

  it('ignores the screen stream while previewSource is camera', async () => {
    const element = makePreviewElement();

    context.previewElement.set(element);
    context.screenStream.set(new MediaStream());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.srcObject).toBeNull();
  });

  it('switches to the screen stream when previewSource changes', async () => {
    const element = makePreviewElement();
    const cameraStream = new MediaStream();
    const screenStream = new MediaStream();

    context.previewElement.set(element);
    context.cameraStream.set(cameraStream);
    context.screenStream.set(screenStream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(cameraStream);
    });

    state.previewSource.set('screen');

    await vi.waitFor(() => {
      expect(element.srcObject).toBe(screenStream);
    });
  });

  it('clears srcObject when the selected stream goes away', async () => {
    const element = makePreviewElement();
    const stream = new MediaStream();

    context.previewElement.set(element);
    context.cameraStream.set(stream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });

    context.cameraStream.set(undefined);

    await vi.waitFor(() => {
      expect(element.srcObject).toBeNull();
    });
  });

  it('clears the old element and wires the new one on element swap', async () => {
    const first = makePreviewElement();
    const second = makePreviewElement();
    const stream = new MediaStream();

    context.previewElement.set(first);
    context.cameraStream.set(stream);
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
    context.cameraStream.set(stream);
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
    context.cameraStream.set(stream);
    await vi.waitFor(() => {
      expect(element.srcObject).toBe(stream);
    });

    const external = new MediaStream();

    element.srcObject = external;
    context.cameraStream.set(undefined);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(element.srcObject).toBe(external);
  });
});
