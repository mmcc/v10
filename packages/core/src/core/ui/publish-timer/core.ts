import type { MediaPublishSessionState, MediaPublishState } from '@videojs/media';
import { createState } from '@videojs/store';
import { defaults } from '@videojs/utils/object';
import { formatTime } from '@videojs/utils/time';
import type { NonNullableObject } from '@videojs/utils/types';

import { resolveText, type Text } from '../../i18n';
import { streamDurationText } from '../../i18n/text/publish';
import type { ButtonState } from '../types';
import { resolveLabel } from '../utils/resolve-label';

export interface PublishTimerProps {
  /** Custom label for accessibility. */
  label?: Text | string | ((state: PublishTimerState) => Text | string) | undefined;
  /**
   * Current timestamp in epoch milliseconds used to compute elapsed time. The core holds no interval — adapters own the
   * tick and pass `Date.now()` on each tick. Falls back to `Date.now()` when unset.
   */
  now?: number | undefined;
}

export interface PublishTimerState extends ButtonState {
  /** Current publish session lifecycle. */
  session: MediaPublishSessionState;
  /** Elapsed time since the session went live, formatted `M:SS` / `H:MM:SS`. */
  elapsedText: string;
}

/**
 * Core state machine for a stream-duration display. Elapsed time is derived from `publishStartedAt` and the `now` prop;
 * `0:00` before the session first goes live.
 */
export class PublishTimerCore {
  static readonly defaultProps: NonNullableObject<PublishTimerProps> = {
    label: '',
    now: Number.NaN,
  };

  readonly state = createState<PublishTimerState>({
    session: 'idle',
    elapsedText: '0:00',
    label: '',
  });

  #props = { ...PublishTimerCore.defaultProps };
  #media: MediaPublishState | null = null;

  constructor(props?: PublishTimerProps) {
    if (props) this.setProps(props);
  }

  setProps(props: PublishTimerProps): void {
    this.#props = defaults(props, PublishTimerCore.defaultProps);
  }

  getLabel(state: PublishTimerState): Text | string {
    const label = resolveLabel(this.#props.label, state);
    if (label) return label;

    return streamDurationText;
  }

  getAttrs(state: PublishTimerState) {
    return {
      'aria-label': this.getLabel(state),
    };
  }

  setMedia(media: MediaPublishState): void {
    this.#media = media;
  }

  getState(): PublishTimerState {
    const media = this.#media!;
    const now = Number.isFinite(this.#props.now) ? this.#props.now : Date.now();
    const seconds = Number.isFinite(media.publishStartedAt) ? Math.max(0, (now - media.publishStartedAt) / 1000) : 0;

    this.state.patch({ session: media.publishState, elapsedText: formatTime(seconds) });
    this.state.patch({ label: resolveText(this.getLabel(this.state.current)) });

    return this.state.current;
  }
}

export namespace PublishTimerCore {
  export type Props = PublishTimerProps;
  export type State = PublishTimerState;
}
