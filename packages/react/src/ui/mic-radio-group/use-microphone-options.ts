'use client';

import { MicRadioGroupCore } from '@videojs/core';
import { logMissingFeature, selectCaptureDevices } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import { useCallback, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';

export interface MicrophoneOptionsProps extends MicRadioGroupCore.Props {}

export interface MicrophoneOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface MicrophoneOptionsResult {
  state: MicRadioGroupCore.State;
  value: string;
  options: MicrophoneOption[];
  disabled: boolean;
  showMenu: boolean;
  setValue: (value: string) => void;
}

/**
 * Create microphone picker menu options from the player capture devices
 * state. Returns `null` when the capture devices feature is not configured.
 *
 * @param props - Optional `label`, `formatDevice`, and `disabled` overrides.
 */
export function useMicrophoneOptions(props?: MicrophoneOptionsProps): MicrophoneOptionsResult | null {
  'use no memo';

  const media = usePlayer(selectCaptureDevices);
  const t = useTranslator();
  const [core] = useState(() => new MicRadioGroupCore());

  core.setProps(props ?? {});

  const setValue = useCallback((value: string) => core.selectValue(media!, value), [core, media]);

  if (!media) {
    if (__DEV__) logMissingFeature('useMicrophoneOptions', selectCaptureDevices.displayName ?? 'captureDevices');
    return null;
  }

  core.setMedia(media);
  const state = core.getState();

  return {
    state,
    value: state.value,
    options: state.devices.map((device) => ({
      value: device.value,
      label: translateText(device.label, t),
      disabled: state.disabled,
    })),
    disabled: state.disabled,
    showMenu: state.availability === 'available',
    setValue,
  };
}

export namespace useMicrophoneOptions {
  export type Props = MicrophoneOptionsProps;
  export type Result = MicrophoneOptionsResult;
  export type Option = MicrophoneOption;
}
