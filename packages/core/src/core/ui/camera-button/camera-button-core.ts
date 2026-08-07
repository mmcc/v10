import type { MediaCaptureTracksState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { cameraOffText, cameraOnText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface CameraButtonProps {
  /** Custom label for the button. */
  label?: Text | string | ((state: CameraButtonState) => Text | string) | undefined;
  /** Whether the button is disabled. */
  disabled?: boolean | undefined;
}

export interface CameraButtonState extends Pick<MediaCaptureTracksState, 'cameraMuted'>, ButtonState {}

export class CameraButtonCore {
  static readonly defaultProps: NonNullableObject<CameraButtonProps> = {
    label: '',
    disabled: false,
  };

  readonly state = createState<CameraButtonState>({
    cameraMuted: false,
    label: '',
  });

  #props = { ...CameraButtonCore.defaultProps };
  #media: MediaCaptureTracksState | null = null;

  constructor(props?: CameraButtonProps) {
    if (props) this.setProps(props);
  }

  setProps(props: CameraButtonProps): void {
    this.#props = defaults(props, CameraButtonCore.defaultProps);
  }

  getLabel(state: CameraButtonState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return state.cameraMuted ? cameraOnText : cameraOffText;
  }

  getAttrs(state: CameraButtonState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': this.#props.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureTracksState): void {
    this.#media = media;
  }

  getState(): CameraButtonState {
    const media = this.#media!;
    this.state.patch({ cameraMuted: media.cameraMuted });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  toggle(media: MediaCaptureTracksState): void {
    if (this.#props.disabled) return;
    media.toggleCameraMuted();
  }
}

export namespace CameraButtonCore {
  export type Props = CameraButtonProps;
  export type State = CameraButtonState;
}
