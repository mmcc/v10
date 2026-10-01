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

  it('marks the device pickers unavailable when at most one device is available', () => {
    const Wrapper = createWrapper({ cameraCount: 1, microphoneCount: 0 });

    render(<PublisherSkin />, { wrapper: Wrapper });

    // The skin's styles hide an unavailable caret, and its menu with it.
    expect(screen.getByRole('button', { name: 'Camera' }).getAttribute('data-availability')).toBe('unavailable');
    expect(screen.getByRole('button', { name: 'Microphone' }).getAttribute('data-availability')).toBe('unavailable');
  });

  it('pairs each device picker with its own capture toggle in one split control', () => {
    const Wrapper = createWrapper({ cameraCount: 2, microphoneCount: 2 });

    render(<PublisherSkin />, { wrapper: Wrapper });

    const cameraControl = screen
      .getByRole('button', { name: 'Turn camera off' })
      .closest('.media-publisher-device-root');
    const micControl = screen.getByRole('button', { name: 'Mute microphone' }).closest('.media-publisher-device-root');

    expect(screen.getByRole('button', { name: 'Camera' }).closest('.media-publisher-device-root')).toBe(cameraControl);
    expect(screen.getByRole('button', { name: 'Microphone' }).closest('.media-publisher-device-root')).toBe(micControl);
    // Each toggle owns exactly one picker — the ambiguity the split control fixes.
    expect(cameraControl).not.toBe(micControl);
  });
});
