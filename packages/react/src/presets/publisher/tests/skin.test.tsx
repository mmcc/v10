import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureDeviceInfo } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

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
    // Capture tracks feature — drives the camera/mic toggles.
    cameraMuted: false,
    micMuted: false,
    setCameraMuted: vi.fn(),
    toggleCameraMuted: vi.fn(),
    setMicMuted: vi.fn(),
    toggleMicMuted: vi.fn(),
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

  it('pairs each device picker with its own capture toggle in one split control', () => {
    const Wrapper = createWrapper({ cameraCount: 2, microphoneCount: 2 });

    render(<PublisherSkin />, { wrapper: Wrapper });

    const cameraControl = screen.getByRole('button', { name: 'Turn camera off' }).closest('.media-device-control');
    const micControl = screen.getByRole('button', { name: 'Mute microphone' }).closest('.media-device-control');

    expect(screen.getByRole('button', { name: 'Camera' }).closest('.media-device-control')).toBe(cameraControl);
    expect(screen.getByRole('button', { name: 'Microphone' }).closest('.media-device-control')).toBe(micControl);
    // Each toggle owns exactly one picker — the ambiguity the split control fixes.
    expect(cameraControl).not.toBe(micControl);
  });
});
