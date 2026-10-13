'use client';

import { cleanup, render, screen } from '@testing-library/react';
import type { MediaCaptureDeviceInfo } from '@videojs/media';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createPlayerWrapper } from '../../../testing/mocks';
import { Menu } from '../../menu';
import { MicRadioGroupOptions, MicRadioGroupRoot } from '../component';

afterEach(cleanup);

function renderMicGroup(optionsProps: { 'aria-label'?: string } = {}) {
  const { Wrapper } = createPlayerWrapper({
    cameras: [],
    microphones: [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Mic' },
      { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Mic' },
    ] as MediaCaptureDeviceInfo[],
    selectedCameraId: '',
    selectedMicrophoneId: 'mic-1',
    selectCamera: vi.fn(),
    selectMicrophone: vi.fn(),
  });

  render(
    <Menu.Root defaultOpen align="center">
      <MicRadioGroupRoot>
        <Menu.Popup>
          <Menu.Content>
            <MicRadioGroupOptions {...optionsProps} renderItem={(props) => <Menu.RadioItem {...props} />} />
          </Menu.Content>
        </Menu.Popup>
      </MicRadioGroupRoot>
    </Menu.Root>,
    { wrapper: Wrapper }
  );
}

describe('MicRadioGroupOptions', () => {
  it('names the group with the translated microphone label', () => {
    renderMicGroup();

    expect(screen.getByRole('group', { name: 'Microphone' })).toBeTruthy();
    expect(screen.getByRole('menuitemradio', { name: 'Built-in Mic' }).getAttribute('data-device')).toBe('mic-1');
  });

  it('keeps an explicit aria-label', () => {
    renderMicGroup({ 'aria-label': 'Audio source' });

    expect(screen.getByRole('group', { name: 'Audio source' })).toBeTruthy();
  });
});
