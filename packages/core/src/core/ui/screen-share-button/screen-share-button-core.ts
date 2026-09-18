import type { MediaCaptureSourceState, MediaFeatureAvailability } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';

import { resolveText, type Text } from '../../i18n';
import { shareScreenText, stopSharingText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface ScreenShareButtonProps {
  /** Custom label for the button. */
  label?: Text | string | ((state: ScreenShareButtonState) => Text | string) | undefined;
  /** Whether the button is disabled. */
  disabled?: boolean | undefined;
}

export interface ScreenShareButtonState extends ButtonState {
  /** Whether the screen is the active capture source. */
  sharing: boolean;
  /** Whether screen capture can be requested on this platform. */
  availability: MediaFeatureAvailability;
}

export class ScreenShareButtonCore {
  static readonly defaultProps: NonNullableObject<ScreenShareButtonProps> = {
    label: '',
    disabled: false,
  };

  readonly state = createState<ScreenShareButtonState>({
    sharing: false,
    availability: 'unsupported',
    label: '',
  });

  #props = { ...ScreenShareButtonCore.defaultProps };
  #media: MediaCaptureSourceState | null = null;

  constructor(props?: ScreenShareButtonProps) {
    if (props) this.setProps(props);
  }

  setProps(props: ScreenShareButtonProps): void {
    this.#props = defaults(props, ScreenShareButtonCore.defaultProps);
  }

  getLabel(state: ScreenShareButtonState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return state.sharing ? stopSharingText : shareScreenText;
  }

  getAttrs(state: ScreenShareButtonState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': this.#props.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureSourceState): void {
    this.#media = media;
  }

  getState(): ScreenShareButtonState {
    const media = this.#media!;

    this.state.patch({
      sharing: media.screenShareActive,
      availability: media.screenShareAvailability,
    });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  toggle(media: MediaCaptureSourceState): void {
    if (this.#props.disabled) return;

    if (media.screenShareAvailability !== 'available') return;

    media.toggleScreenShare();
  }
}

export namespace ScreenShareButtonCore {
  export type Props = ScreenShareButtonProps;
  export type State = ScreenShareButtonState;
}
