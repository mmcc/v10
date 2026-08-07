import type { MediaConnectionQuality, MediaPublishStatsState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';
import { resolveText, type Text } from '../../i18n';
import {
  connectionFairText,
  connectionGoodText,
  connectionPoorText,
  connectionUnknownText,
} from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface ConnectionIndicatorProps {
  /** Custom label for the indicator. */
  label?: Text | string | ((state: ConnectionIndicatorState) => Text | string) | undefined;
}

export interface ConnectionIndicatorState extends ButtonState {
  /** Coarse connection health derived from recent publish stats. */
  quality: MediaConnectionQuality;
}

export class ConnectionIndicatorCore {
  static readonly defaultProps: NonNullableObject<ConnectionIndicatorProps> = {
    label: '',
  };

  readonly state = createState<ConnectionIndicatorState>({
    quality: 'unknown',
    label: '',
  });

  #props = { ...ConnectionIndicatorCore.defaultProps };
  #media: MediaPublishStatsState | null = null;

  constructor(props?: ConnectionIndicatorProps) {
    if (props) this.setProps(props);
  }

  setProps(props: ConnectionIndicatorProps): void {
    this.#props = defaults(props, ConnectionIndicatorCore.defaultProps);
  }

  getLabel(state: ConnectionIndicatorState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    if (state.quality === 'good') return connectionGoodText;
    if (state.quality === 'fair') return connectionFairText;
    if (state.quality === 'poor') return connectionPoorText;
    return connectionUnknownText;
  }

  getAttrs(state: ConnectionIndicatorState) {
    return {
      // The visual is an icon tinted by quality — expose the quality as text
      // so the state is not color-only.
      role: 'img' as const,
      'aria-label': this.getLabel(state),
    };
  }

  setMedia(media: MediaPublishStatsState): void {
    this.#media = media;
  }

  getState(): ConnectionIndicatorState {
    const media = this.#media!;
    this.state.patch({ quality: media.connectionQuality });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }
}

export namespace ConnectionIndicatorCore {
  export type Props = ConnectionIndicatorProps;
  export type State = ConnectionIndicatorState;
}
