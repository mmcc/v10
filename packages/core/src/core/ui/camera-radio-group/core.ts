import type { MediaCaptureDeviceInfo, MediaCaptureDevicesState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';

import { resolveText, type Text } from '../../i18n';
import { cameraText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface CameraRadioGroupProps {
  /** Custom label for the options group. */
  label?: Text | string | ((state: CameraRadioGroupState) => Text | string) | undefined;
  /** Custom formatter for visible device labels. */
  formatDevice?: ((device: MediaCaptureDeviceInfo, index: number) => Text | string) | undefined;
  /** Whether camera selection is disabled. */
  disabled?: boolean | undefined;
}

export interface CameraRadioGroupDevice {
  value: string;
  label: Text | string;
}

export interface CameraRadioGroupState extends ButtonState {
  devices: readonly CameraRadioGroupDevice[];
  value: string;
  disabled: boolean;
  availability: 'available' | 'unavailable';
}

/** Device labels are empty until capture permission is granted — fall back to "Camera n". */
function formatDeviceLabel(device: MediaCaptureDeviceInfo, index: number): Text | string {
  if (device.label) return device.label;

  return `${resolveText(cameraText)} ${index + 1}`;
}

export class CameraRadioGroupCore {
  static readonly defaultProps: NonNullableObject<CameraRadioGroupProps> = {
    label: '',
    formatDevice: formatDeviceLabel,
    disabled: false,
  };

  readonly state = createState<CameraRadioGroupState>({
    devices: [],
    value: '',
    disabled: false,
    availability: 'unavailable',
    label: '',
  });

  #props = { ...CameraRadioGroupCore.defaultProps };
  #media: MediaCaptureDevicesState | null = null;

  constructor(props?: CameraRadioGroupProps) {
    if (props) this.setProps(props);
  }

  setProps(props: CameraRadioGroupProps): void {
    this.#props = defaults(props, CameraRadioGroupCore.defaultProps);
  }

  getLabel(state: CameraRadioGroupState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return cameraText;
  }

  getDeviceLabel(device: MediaCaptureDeviceInfo, index: number): Text | string {
    return this.#props.formatDevice(device, index);
  }

  getAttrs(state: CameraRadioGroupState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': state.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureDevicesState): void {
    this.#media = media;
  }

  getState(): CameraRadioGroupState {
    const media = this.#media!;
    const devices = media.cameras.map((device, index) => ({
      value: device.deviceId,
      label: this.getDeviceLabel(device, index),
    }));
    const availability: CameraRadioGroupState['availability'] = devices.length > 1 ? 'available' : 'unavailable';

    this.state.patch({
      devices,
      value: media.selectedCameraId,
      disabled: this.#props.disabled || availability === 'unavailable',
      availability,
    });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  select(media: MediaCaptureDevicesState, value: string): void {
    if (this.#props.disabled) return;

    const hasValue = media.cameras.some((device) => device.deviceId === value);
    if (!hasValue) return;

    media.selectCamera(value);
  }

  selectValue(media: MediaCaptureDevicesState, value: string): void {
    this.select(media, value);
  }
}

export namespace CameraRadioGroupCore {
  export type Props = CameraRadioGroupProps;
  export type State = CameraRadioGroupState;
}
