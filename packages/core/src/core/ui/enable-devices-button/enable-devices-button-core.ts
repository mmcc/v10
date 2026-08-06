import type { MediaCaptureSourceState, MediaCaptureState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { enableDevicesText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { aggregateCaptureState } from '../utils/aggregate-capture-state';
import { resolveLabel } from '../utils/resolve-label';

export interface EnableDevicesButtonProps {
  /** Custom label for the button. */
  label?: Text | string | ((state: EnableDevicesButtonState) => Text | string) | undefined;
  /** Whether the button is disabled. */
  disabled?: boolean | undefined;
}

export interface EnableDevicesButtonState extends ButtonState {
  /** Current capture lifecycle. */
  captureState: MediaCaptureState;
  /** Whether the button is disabled (via props or while acquiring). */
  disabled: boolean;
}

/**
 * Core state machine for an "Enable camera and microphone" button. Activating
 * it selects the camera capture source, which prompts for device permission
 * as needed.
 */
export class EnableDevicesButtonCore {
  static readonly defaultProps: NonNullableObject<EnableDevicesButtonProps> = {
    label: '',
    disabled: false,
  };

  readonly state = createState<EnableDevicesButtonState>({
    captureState: 'idle',
    disabled: false,
    label: '',
  });

  #props = { ...EnableDevicesButtonCore.defaultProps };
  #media: MediaCaptureSourceState | null = null;

  constructor(props?: EnableDevicesButtonProps) {
    if (props) this.setProps(props);
  }

  setProps(props: EnableDevicesButtonProps): void {
    this.#props = defaults(props, EnableDevicesButtonCore.defaultProps);
  }

  getLabel(state: EnableDevicesButtonState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return enableDevicesText;
  }

  getAttrs(state: EnableDevicesButtonState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': state.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureSourceState): void {
    this.#media = media;
  }

  getState(): EnableDevicesButtonState {
    const media = this.#media!;

    this.state.patch({
      captureState: aggregateCaptureState(media.cameraState, media.screenShareState),
      // Disabled only while the CAMERA pipeline is mid-acquisition — the
      // sources are independently acquirable, so an open screen-share
      // picker must not grey out the camera CTA (matching activate()'s
      // own guard).
      disabled: this.#props.disabled || media.cameraState === 'acquiring',
    });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  activate(media: MediaCaptureSourceState): void {
    if (this.#props.disabled) return;
    if (media.cameraState === 'acquiring') return;
    // Safe because the acquire behavior consumes the intent on
    // `denied`/`ended`: cameraActive can only read true while acquisition
    // is genuinely being served, so this never blocks a retry.
    if (media.cameraActive) return;

    media.toggleCamera();
  }
}

export namespace EnableDevicesButtonCore {
  export type Props = EnableDevicesButtonProps;
  export type State = EnableDevicesButtonState;
}
