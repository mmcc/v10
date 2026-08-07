import type { MediaCaptureSourceState, MediaPublishSessionState, MediaPublishState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { connectingText, goLiveText, stoppingText, stopStreamText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { aggregateCaptureState } from '../utils/aggregate-capture-state';
import { resolveLabel } from '../utils/resolve-label';

export interface PublishButtonProps {
  /** Custom label for the button. */
  label?: Text | string | ((state: PublishButtonState) => Text | string) | undefined;
  /** Whether the button is disabled. */
  disabled?: boolean | undefined;
}

/**
 * Media state slice consumed by `PublishButtonCore` — composed by the HTML
 * and React `PublishButton` adapters from the `publish` and `capture-source`
 * store slices.
 */
export type PublishButtonMediaState = MediaPublishState & Pick<MediaCaptureSourceState, 'cameraState' | 'screenShareState'>;

export interface PublishButtonState extends ButtonState {
  /** Current publish session lifecycle. */
  session: MediaPublishSessionState;
  /** Whether the button is disabled (via props, no active capture, or a session transition). */
  disabled: boolean;
}

/**
 * Core state machine for a "Go live" button. Starts a publish session from
 * `idle`/`error`, stops it from `live`/`connecting`, and disables itself
 * while capture is inactive or the session is transitioning.
 */
export class PublishButtonCore {
  static readonly defaultProps: NonNullableObject<PublishButtonProps> = {
    label: '',
    disabled: false,
  };

  readonly state = createState<PublishButtonState>({
    session: 'idle',
    disabled: false,
    label: '',
  });

  #props = { ...PublishButtonCore.defaultProps };
  #media: PublishButtonMediaState | null = null;

  constructor(props?: PublishButtonProps) {
    if (props) this.setProps(props);
  }

  setProps(props: PublishButtonProps): void {
    this.#props = defaults(props, PublishButtonCore.defaultProps);
  }

  getLabel(state: PublishButtonState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    if (state.session === 'live') return stopStreamText;
    if (state.session === 'connecting') return connectingText;
    if (state.session === 'stopping') return stoppingText;
    return goLiveText;
  }

  getAttrs(state: PublishButtonState) {
    return {
      'aria-label': this.getLabel(state),
      'aria-disabled': state.disabled ? 'true' : undefined,
    };
  }

  setMedia(media: PublishButtonMediaState): void {
    this.#media = media;
  }

  getState(): PublishButtonState {
    const media = this.#media!;
    const session = media.publishState;
    const captureState = aggregateCaptureState(media.cameraState, media.screenShareState);

    this.state.patch({
      session,
      disabled: this.#props.disabled || captureState !== 'active' || session === 'connecting' || session === 'stopping',
    });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }

  async toggle(media: PublishButtonMediaState): Promise<void> {
    if (this.#props.disabled) return;

    const session = media.publishState;

    if (session === 'live' || session === 'connecting') {
      media.unpublish();
      return;
    }

    if (session === 'stopping') return;
    if (aggregateCaptureState(media.cameraState, media.screenShareState) !== 'active') return;

    try {
      // idle/error → start (or retry) a session.
      await media.publish();
    } catch {
      // Swallowed: the media store surfaces failures via `publishState`.
    }
  }
}

export namespace PublishButtonCore {
  export type Props = PublishButtonProps;
  export type State = PublishButtonState;
  export type MediaState = PublishButtonMediaState;
}
