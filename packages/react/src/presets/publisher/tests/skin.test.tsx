import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureDeviceInfo } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlayerWrapper } from '../../../testing/mocks';
import { PublisherSkin } from '../skin';

afterEach(() => {
  cleanup();
});

function createDevice(kind: MediaCaptureDeviceInfo['kind'], index: number): MediaCaptureDeviceInfo {
  return { deviceId: `${kind}-${index}`, kind, label: `${kind} ${index}` };
}

function createWrapper({ cameraCount = 2, microphoneCount = 2 } = {}) {
  return createPlayerWrapper({
    // Controls feature — the skin's control bar renders nothing without it.
    controlsVisible: true,
    userActive: true,
    // Capture devices feature — drives the device picker menus.
    cameras: Array.from({ length: cameraCount }, (_, index) => createDevice('videoinput', index)),
    microphones: Array.from({ length: microphoneCount }, (_, index) => createDevice('audioinput', index)),
    selectedCameraId: '',
    selectedMicrophoneId: '',
    selectCamera: vi.fn(),
    selectMicrophone: vi.fn(),
  }).Wrapper;
}

describe('PublisherSkin', () => {
  it('shows the device picker menus when there is a device choice to make', () => {
    const Wrapper = createWrapper({ cameraCount: 2, microphoneCount: 2 });

    render(<PublisherSkin />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: 'Camera' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Microphone' })).toBeTruthy();
  });

  it('hides the device picker menus when at most one device is available', () => {
    const Wrapper = createWrapper({ cameraCount: 1, microphoneCount: 0 });

    render(<PublisherSkin />, { wrapper: Wrapper });

    expect(screen.queryByRole('button', { name: 'Camera' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Microphone' })).toBeNull();
  });
});
