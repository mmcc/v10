'use client';

import { CameraRadioGroupCore } from '@videojs/core';
import { logMissingFeature, selectCaptureDevices } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import { useCallback, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';

export interface CameraOptionsProps extends CameraRadioGroupCore.Props {}

export interface CameraOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface CameraOptionsResult {
  state: CameraRadioGroupCore.State;
  value: string;
  options: CameraOption[];
  disabled: boolean;
  showMenu: boolean;
  setValue: (value: string) => void;
}

/**
 * Create camera picker menu options from the player capture devices state.
 * Returns `null` when the capture devices feature is not configured.
 *
 * @param props - Optional `label`, `formatDevice`, and `disabled` overrides.
 */
export function useCameraOptions(props?: CameraOptionsProps): CameraOptionsResult | null {
  'use no memo';

  const media = usePlayer(selectCaptureDevices);
  const t = useTranslator();
  const [core] = useState(() => new CameraRadioGroupCore());

  core.setProps(props ?? {});

  const setValue = useCallback((value: string) => core.selectValue(media!, value), [core, media]);

  if (!media) {
    if (__DEV__) logMissingFeature('useCameraOptions', selectCaptureDevices.displayName ?? 'captureDevices');
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

export namespace useCameraOptions {
  export type Props = CameraOptionsProps;
  export type Result = CameraOptionsResult;
  export type Option = CameraOption;
}
