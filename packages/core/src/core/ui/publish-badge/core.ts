import type { MediaPublishSessionState, MediaPublishState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import type { NonNullableObject } from '@videojs/utils/types';

import { resolveText, type Text } from '../../i18n';
import { badgeText } from '../../i18n/text/live';
import { connectingText, offlineText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface PublishBadgeProps {
  /** Custom label for the badge. */
  label?: Text | string | ((state: PublishBadgeState) => Text | string) | undefined;
}

export interface PublishBadgeState extends ButtonState {
  /** Current publish session lifecycle. */
  session: MediaPublishSessionState;
}

/**
 * Core state machine for a publish status badge. Its label reflects the session lifecycle: "Live" while publishing,
 * "Connecting…" during session setup, and "Offline" otherwise (idle, stopping, or error).
 */
export class PublishBadgeCore {
  static readonly defaultProps: NonNullableObject<PublishBadgeProps> = {
    label: '',
  };

  readonly state = createState<PublishBadgeState>({
    session: 'idle',
    label: '',
  });

  #props = { ...PublishBadgeCore.defaultProps };
  #media: MediaPublishState | null = null;

  constructor(props?: PublishBadgeProps) {
    if (props) this.setProps(props);
  }

  setProps(props: PublishBadgeProps): void {
    this.#props = defaults(props, PublishBadgeCore.defaultProps);
  }

  getLabel(state: PublishBadgeState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    if (state.session === 'live') return badgeText;

    if (state.session === 'connecting') return connectingText;

    return offlineText;
  }

  getAttrs(state: PublishBadgeState) {
    return {
      'aria-label': this.getLabel(state),
    };
  }

  setMedia(media: MediaPublishState): void {
    this.#media = media;
  }

  getState(): PublishBadgeState {
    const media = this.#media!;

    this.state.patch({ session: media.publishState });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }
}

export namespace PublishBadgeCore {
  export type Props = PublishBadgeProps;
  export type State = PublishBadgeState;
}
