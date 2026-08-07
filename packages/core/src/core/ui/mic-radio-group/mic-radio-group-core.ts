import type { MediaCaptureDeviceInfo, MediaCaptureDevicesState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { microphoneText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface MicRadioGroupProps {
  /** Custom label for the options group. */
  label?: Text | string | ((state: MicRadioGroupState) => Text | string) | undefined;
  /** Custom formatter for visible device labels. */
  formatDevice?: ((device: MediaCaptureDeviceInfo, index: number) => Text | string) | undefined;
  /** Whether microphone selection is disabled. */
  disabled?: boolean | undefined;
}

export interface MicRadioGroupDevice {
  value: string;
  label: Text | string;
}

export interface MicRadioGroupState extends ButtonState {
  devices: readonly MicRadioGroupDevice[];
  value: string;
  disabled: boolean;
  availability: 'available' | 'unavailable';
}

/** Device labels are empty until capture permission is granted — fall back to "Microphone n". */
function formatDeviceLabel(device: MediaCaptureDeviceInfo, index: number): Text | string {
  if (device.label) return device.label;
  return `${resolveText(microphoneText)} ${index + 1}`;
}

export class MicRadioGroupCore {
  static readonly defaultProps: NonNullableObject<MicRadioGroupProps> = {
    label: '',
    formatDevice: formatDeviceLabel,
    disabled: false,
  };

  readonly state = createState<MicRadioGroupState>({
    devices: [],
    value: '',
    disabled: false,
    availability: 'unavailable',
    label: '',
  });

  #props = { ...MicRadioGroupCore.defaultProps };
  #media: MediaCaptureDevicesState | null = null;

  constructor(props?: MicRadioGroupProps) {
    if (props) this.setProps(props);
  }

  setProps(props: MicRadioGroupProps): void {
    this.#props = defaults(props, MicRadioGroupCore.defaultProps);
  }

  getLabel(state: MicRadioGroupState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return microphoneText;
  }

  getDeviceLabel(device: MediaCaptureDeviceInfo, index: number): Text | string {
    return this.#props.formatDevice(device, index);
  }

  getAttrs(state: MicRadioGroupState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': state.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureDevicesState): void {
    this.#media = media;
  }

  getState(): MicRadioGroupState {
    const media = this.#media!;
    const devices = media.microphones.map((device, index) => ({
      value: device.deviceId,
      label: this.getDeviceLabel(device, index),
    }));
    const availability: MicRadioGroupState['availability'] = devices.length > 1 ? 'available' : 'unavailable';

    this.state.patch({
      devices,
      value: media.selectedMicrophoneId,
      disabled: this.#props.disabled || availability === 'unavailable',
      availability,
    });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  select(media: MediaCaptureDevicesState, value: string): void {
    if (this.#props.disabled) return;

    const hasValue = media.microphones.some((device) => device.deviceId === value);
    if (!hasValue) return;

    media.selectMicrophone(value);
  }

  selectValue(media: MediaCaptureDevicesState, value: string): void {
    this.select(media, value);
  }
}

export namespace MicRadioGroupCore {
  export type Props = MicRadioGroupProps;
  export type State = MicRadioGroupState;
}
