import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateSignals } from '../../../../core/composition/create-composition';
import { signal } from '../../../../core/signals/primitives';
import { type EnumerateCaptureDevicesState, enumerateCaptureDevices } from '../enumerate-capture-devices';

function makeState(initial: EnumerateCaptureDevicesState = {}): StateSignals<EnumerateCaptureDevicesState> {
  return {
    captureDevices: signal(initial.captureDevices),
    captureStatus: signal(initial.captureStatus ?? 'idle'),
  };
}

function fakeDevice(deviceId: string, kind: MediaDeviceKind, label = ''): MediaDeviceInfo {
  return { deviceId, kind, label, groupId: 'group-1' } as MediaDeviceInfo;
}

const disposals: (() => void)[] = [];

function setupEnumerate() {
  const state = makeState();
  const cleanup = enumerateCaptureDevices.setup({ state });
  if (cleanup) disposals.push(cleanup);
  return { state, cleanup };
}

describe('enumerateCaptureDevices', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('enumerates capture inputs on setup, filtering out non-input devices', async () => {
    vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([
      fakeDevice('cam-1', 'videoinput', 'Fake camera'),
      fakeDevice('mic-1', 'audioinput', 'Fake microphone'),
      fakeDevice('speaker-1', 'audiooutput', 'Fake speaker'),
    ]);
    const { state } = setupEnumerate();

    await vi.waitFor(() => {
      expect(state.captureDevices.get()).toEqual([
        { deviceId: 'cam-1', kind: 'videoinput', label: 'Fake camera' },
        { deviceId: 'mic-1', kind: 'audioinput', label: 'Fake microphone' },
      ]);
    });
  });

  it('re-enumerates on devicechange', async () => {
    const enumerate = vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([]);
    setupEnumerate();

    await vi.waitFor(() => {
      expect(enumerate).toHaveBeenCalledTimes(1);
    });

    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));

    await vi.waitFor(() => {
      expect(enumerate).toHaveBeenCalledTimes(2);
    });
  });

  it('re-enumerates when captureStatus becomes active (labels appear post-grant)', async () => {
    const enumerate = vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([]);
    const { state } = setupEnumerate();

    await vi.waitFor(() => {
      expect(enumerate).toHaveBeenCalledTimes(1);
    });

    state.captureStatus.set('acquiring');
    state.captureStatus.set('active');

    await vi.waitFor(() => {
      expect(enumerate).toHaveBeenCalledTimes(2);
    });
  });

  it('stops listening after cleanup', async () => {
    const enumerate = vi.spyOn(navigator.mediaDevices, 'enumerateDevices').mockResolvedValue([]);
    const { state, cleanup } = setupEnumerate();

    await vi.waitFor(() => {
      expect(enumerate).toHaveBeenCalledTimes(1);
    });

    cleanup?.();
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    state.captureStatus.set('active');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enumerate).toHaveBeenCalledTimes(1);
  });
});
