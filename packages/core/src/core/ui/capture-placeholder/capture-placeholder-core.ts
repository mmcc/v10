import type { MediaCaptureSourceState, MediaCaptureState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import { connectingText, enableDevicesText, permissionDeniedText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { aggregateCaptureState } from '../utils/aggregate-capture-state';
import { resolveLabel } from '../utils/resolve-label';

export interface CapturePlaceholderProps {
  /** Custom label for the placeholder. */
  label?: Text | string | ((state: CapturePlaceholderState) => Text | string) | undefined;
}

export interface CapturePlaceholderState extends ButtonState {
  /** Current capture lifecycle. */
  captureState: MediaCaptureState;
}

/**
 * Core state machine for the placeholder shown over the preview area before
 * any capture source is active. Its label is an enable-devices CTA while
 * `idle` or `ended`, a progress hint while `acquiring`, permission guidance
 * when `denied`, and empty once any counted source is `active`.
 */
export class CapturePlaceholderCore {
  static readonly defaultProps: NonNullableObject<CapturePlaceholderProps> = {
    label: '',
  };

  readonly state = createState<CapturePlaceholderState>({
    captureState: 'idle',
    label: '',
  });

  #props = { ...CapturePlaceholderCore.defaultProps };
  #media: MediaCaptureSourceState | null = null;

  constructor(props?: CapturePlaceholderProps) {
    if (props) this.setProps(props);
  }

  setProps(props: CapturePlaceholderProps): void {
    this.#props = defaults(props, CapturePlaceholderCore.defaultProps);
  }

  getLabel(state: CapturePlaceholderState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    if (state.captureState === 'denied') return permissionDeniedText;
    if (state.captureState === 'acquiring') return connectingText;
    if (state.captureState === 'active') return '';
    return enableDevicesText;
  }

  getAttrs(state: CapturePlaceholderState) {
    return {
      'aria-label': this.getLabel(state) || undefined,
    };
  }

  setMedia(media: MediaCaptureSourceState): void {
    this.#media = media;
  }

  getState(): CapturePlaceholderState {
    const media = this.#media!;
    this.state.patch({ captureState: aggregateCaptureState(media) });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }
}

export namespace CapturePlaceholderCore {
  export type Props = CapturePlaceholderProps;
  export type State = CapturePlaceholderState;
}
