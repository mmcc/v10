import type { MediaCaptureTracksState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { micMuteText, micUnmuteText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface MicButtonProps {
  /** Custom label for the button. */
  label?: Text | string | ((state: MicButtonState) => Text | string) | undefined;
  /** Whether the button is disabled. */
  disabled?: boolean | undefined;
}

export interface MicButtonState extends Pick<MediaCaptureTracksState, 'micMuted'>, ButtonState {}

export class MicButtonCore {
  static readonly defaultProps: NonNullableObject<MicButtonProps> = {
    label: '',
    disabled: false,
  };

  readonly state = createState<MicButtonState>({
    micMuted: false,
    label: '',
  });

  #props = { ...MicButtonCore.defaultProps };
  #media: MediaCaptureTracksState | null = null;

  constructor(props?: MicButtonProps) {
    if (props) this.setProps(props);
  }

  setProps(props: MicButtonProps): void {
    this.#props = defaults(props, MicButtonCore.defaultProps);
  }

  getLabel(state: MicButtonState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return state.micMuted ? micUnmuteText : micMuteText;
  }

  getAttrs(state: MicButtonState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': this.#props.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: MediaCaptureTracksState): void {
    this.#media = media;
  }

  getState(): MicButtonState {
    const media = this.#media!;
    this.state.patch({ micMuted: media.micMuted });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  toggle(media: MediaCaptureTracksState): void {
    if (this.#props.disabled) return;
    media.toggleMicMuted();
  }
}

export namespace MicButtonCore {
  export type Props = MicButtonProps;
  export type State = MicButtonState;
}
