'use client';

import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureDeviceInfo } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { Menu } from '../../menu';
import { CameraRadioGroupOptions, CameraRadioGroupRoot } from '../component';

afterEach(cleanup);

function renderCameraGroup(optionsProps: { 'aria-label'?: string } = {}) {
  const { Wrapper } = createPlayerWrapper({
    cameras: [
      { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' },
      { deviceId: 'cam-2', kind: 'videoinput', label: 'iPhone Camera' },
    ] as MediaCaptureDeviceInfo[],
    microphones: [],
    selectedCameraId: 'cam-1',
    selectedMicrophoneId: '',
    selectCamera: vi.fn(),
    selectMicrophone: vi.fn(),
  });

  render(
    <Menu.Root defaultOpen align="center">
      <CameraRadioGroupRoot>
        <Menu.Popup>
          <Menu.Content>
            <CameraRadioGroupOptions {...optionsProps} renderItem={(props) => <Menu.RadioItem {...props} />} />
          </Menu.Content>
        </Menu.Popup>
      </CameraRadioGroupRoot>
    </Menu.Root>,
    { wrapper: Wrapper }
  );
}

describe('CameraRadioGroupOptions', () => {
  it('names the group with the translated camera label', () => {
    renderCameraGroup();

    expect(screen.getByRole('group', { name: 'Camera' })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: 'FaceTime HD' }).getAttribute('data-device')).toBe('cam-1');
  });

  it('keeps an explicit aria-label', () => {
    renderCameraGroup({ 'aria-label': 'Video source' });

    expect(screen.getByRole('group', { name: 'Video source' })).toBeTruthy();
  });
});
