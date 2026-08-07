'use client';

import { PublishTimerCore, PublishTimerDataAttrs } from '@videojs/core';
import { logMissingFeature, selectPublish } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import type { ForwardedRef } from 'react';
import { forwardRef, useEffect, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';
import type { UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';

const DISPLAY_NAME = 'PublishTimer';

export interface PublishTimerProps
  extends Omit<UIComponentProps<'div', PublishTimerCore.State>, 'children'>,
    Omit<PublishTimerCore.Props, 'now'> {}

/**
 * Displays the elapsed time since the publish session went live, formatted
 * `M:SS` / `H:MM:SS` (`0:00` before the session first goes live).
 *
 * `PublishTimerCore` is tick-less: this component owns a one-second interval
 * that runs only while the session is `live`, passing a fresh `now` to the
 * core on every tick.
 *
 * @example
 * ```tsx
 * <PublishTimer />
 * ```
 */
export const PublishTimer = forwardRef(function PublishTimer(
  componentProps: PublishTimerProps,
  forwardedRef: ForwardedRef<HTMLDivElement>
) {
  const { render, className, style, label, ...elementProps } = componentProps;

  const publish = usePlayer(selectPublish);
  const translator = useTranslator();
  const [core] = useState(() => new PublishTimerCore());
  const [now, setNow] = useState(() => Date.now());
  core.setProps({ label, now });

  const live = !!publish && publish.publishState === 'live';

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [live]);

  if (!publish) {
    if (__DEV__) logMissingFeature(DISPLAY_NAME, selectPublish.displayName ?? 'publish');
    return null;
  }

  core.setMedia(publish);
  const state = core.getState();
  const attrs = core.getAttrs(state);

  return renderElement(
    'div',
    { render, className, style },
    {
      state,
      stateAttrMap: PublishTimerDataAttrs,
      ref: [forwardedRef],
      props: [
        {
          children: state.elapsedText,
          ...elementProps,
          'aria-label': translateText(attrs['aria-label'], translator),
        },
      ],
    }
  );
});

PublishTimer.displayName = DISPLAY_NAME;

export namespace PublishTimer {
  export type Props = PublishTimerProps;
  export type State = PublishTimerCore.State;
}
