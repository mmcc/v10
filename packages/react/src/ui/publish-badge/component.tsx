'use client';

import { PublishBadgeCore, PublishBadgeDataAttrs } from '@videojs/core';
import { logMissingFeature, selectPublish } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import type { ForwardedRef } from 'react';
import { forwardRef, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';
import type { UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';

const DISPLAY_NAME = 'PublishBadge';

export interface PublishBadgeProps extends UIComponentProps<'div', PublishBadgeCore.State>, PublishBadgeCore.Props {}

/**
 * A badge that reflects the publish session lifecycle ("Live", "Connecting…", or "Offline"). Renders the translated
 * session label when no children are provided and exposes `data-publish-state` for styling.
 *
 * @example
 *   ```tsx
 *   <PublishBadge />;
 *   ```;
 */
export const PublishBadge = forwardRef(function PublishBadge(
  componentProps: PublishBadgeProps,
  forwardedRef: ForwardedRef<HTMLDivElement>
) {
  const { children, render, className, style, label, ...elementProps } = componentProps;

  const publish = usePlayer(selectPublish);
  const translator = useTranslator();
  const [core] = useState(() => new PublishBadgeCore());

  core.setProps({ label });

  if (!publish) {
    if (__DEV__) logMissingFeature(DISPLAY_NAME, selectPublish.displayName ?? 'publish');

    return null;
  }

  core.setMedia(publish);
  const state = core.getState();
  const labelText = translateText(core.getLabel(state), translator);

  return renderElement(
    'div',
    { render, className, style },
    {
      state,
      stateAttrMap: PublishBadgeDataAttrs,
      ref: [forwardedRef],
      props: [
        {
          children: children ?? labelText,
          ...elementProps,
          'aria-label': labelText,
        },
      ],
    }
  );
});

PublishBadge.displayName = DISPLAY_NAME;

export namespace PublishBadge {
  export type Props = PublishBadgeProps;
  export type State = PublishBadgeCore.State;
}
