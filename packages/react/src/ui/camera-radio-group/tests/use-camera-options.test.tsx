'use client';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MediaCaptureDeviceInfo } from '@videojs/media';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { Menu } from '../../menu';
import { useCameraOptions } from '../use-camera-options';

afterEach(cleanup);

function renderCameraOptions({
  cameras = [
    { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' },
    { deviceId: 'cam-2', kind: 'videoinput', label: 'iPhone Camera' },
  ] as MediaCaptureDeviceInfo[],
  selectedCameraId = 'cam-1',
  selectCamera = vi.fn(),
} = {}) {
  const { Wrapper } = createPlayerWrapper({
    cameras,
    microphones: [],
    selectedCameraId,
    selectedMicrophoneId: '',
    selectCamera,
    selectMicrophone: vi.fn(),
  });

  render(
    <Menu.Root defaultOpen align="center">
      <Menu.Popup>
        <Menu.Content data-testid="content">
          <CameraRadioGroup />
        </Menu.Content>
      </Menu.Popup>
    </Menu.Root>,
    { wrapper: Wrapper }
  );

  return { selectCamera };
}

function CameraRadioGroup(): ReactNode {
  const cameras = useCameraOptions();
  if (!cameras) return null;

  const { options, setValue, value } = cameras;

  return (
    <Menu.RadioGroup value={value} onValueChange={setValue} aria-label="Camera">
      {options.map((option) => (
        <Menu.RadioItem key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

describe('useCameraOptions', () => {
  it('renders camera device options', () => {
    renderCameraOptions();

    expect(screen.getByRole('menuitemradio', { name: 'FaceTime HD' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'iPhone Camera' }).getAttribute('aria-checked')).toBe('false');
  });

  it('selects a camera device', () => {
    const selectCamera = vi.fn();

    renderCameraOptions({ selectCamera });

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'iPhone Camera' }));

    expect(selectCamera).toHaveBeenCalledWith('cam-2');
  });

  it('falls back to a numbered label until device labels are granted', () => {
    renderCameraOptions({
      cameras: [
        { deviceId: 'cam-1', kind: 'videoinput', label: '' },
        { deviceId: 'cam-2', kind: 'videoinput', label: '' },
      ],
    });

    expect(screen.getByRole('menuitemradio', { name: 'Camera 1' })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: 'Camera 2' })).toBeTruthy();
  });

  it('disables options when only one camera is available', () => {
    renderCameraOptions({
      cameras: [{ deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' }],
    });

    expect(screen.getByRole('menuitemradio', { name: 'FaceTime HD' }).getAttribute('aria-disabled')).toBe('true');
  });
});
