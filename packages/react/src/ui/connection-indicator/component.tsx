'use client';

import { ConnectionIndicatorCore, ConnectionIndicatorDataAttrs } from '@videojs/core';
import { logMissingFeature, selectPublishStats } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import type { ForwardedRef } from 'react';
import { forwardRef, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';
import type { UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';

const DISPLAY_NAME = 'ConnectionIndicator';

export interface ConnectionIndicatorProps
  extends UIComponentProps<'div', ConnectionIndicatorCore.State>, ConnectionIndicatorCore.Props {}

/**
 * Indicates coarse connection health for the active publish session. Content (typically an icon) is authored by the
 * skin; the component exposes `data-quality` (`unknown`, `good`, `fair`, or `poor`) for styling.
 *
 * @example
 *   ```tsx
 *   <ConnectionIndicator>
 *     <SignalIcon />
 *   </ConnectionIndicator>;
 *   ```;
 */
export const ConnectionIndicator = forwardRef(function ConnectionIndicator(
  componentProps: ConnectionIndicatorProps,
  forwardedRef: ForwardedRef<HTMLDivElement>
) {
  const { render, className, style, label, ...elementProps } = componentProps;

  const publishStats = usePlayer(selectPublishStats);
  const translator = useTranslator();
  const [core] = useState(() => new ConnectionIndicatorCore());

  core.setProps({ label });

  if (!publishStats) {
    if (__DEV__) logMissingFeature(DISPLAY_NAME, selectPublishStats.displayName ?? 'publishStats');

    return null;
  }

  core.setMedia(publishStats);
  const state = core.getState();
  const attrs = core.getAttrs(state);

  return renderElement(
    'div',
    { render, className, style },
    {
      state,
      stateAttrMap: ConnectionIndicatorDataAttrs,
      ref: [forwardedRef],
      props: [
        {
          ...elementProps,
          role: attrs.role,
          'aria-label': translateText(attrs['aria-label'], translator),
        },
      ],
    }
  );
});

ConnectionIndicator.displayName = DISPLAY_NAME;

export namespace ConnectionIndicator {
  export type Props = ConnectionIndicatorProps;
  export type State = ConnectionIndicatorCore.State;
}
