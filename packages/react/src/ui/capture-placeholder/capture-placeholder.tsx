'use client';

import { CapturePlaceholderCore, CapturePlaceholderDataAttrs } from '@videojs/core';
import { logMissingFeature, selectCaptureSource } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import type { ForwardedRef } from 'react';
import { forwardRef, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';
import type { UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';

const DISPLAY_NAME = 'CapturePlaceholder';

export interface CapturePlaceholderProps
  extends UIComponentProps<'div', CapturePlaceholderCore.State>,
    CapturePlaceholderCore.Props {}

/**
 * A placeholder shown over the preview area before capture is active.
 * Authored children pass through as-is; without them it renders the core's
 * translated guidance text (an enable-devices CTA, a progress hint, or
 * permission guidance). Visibility is a styling concern: skins show/hide it
 * via the `data-capture-state` attribute.
 *
 * @example
 * ```tsx
 * <CapturePlaceholder />
 * ```
 */
export const CapturePlaceholder = forwardRef(function CapturePlaceholder(
  componentProps: CapturePlaceholderProps,
  forwardedRef: ForwardedRef<HTMLDivElement>
) {
  const { children, render, className, style, label, ...elementProps } = componentProps;

  const captureSource = usePlayer(selectCaptureSource);
  const translator = useTranslator();
  const [core] = useState(() => new CapturePlaceholderCore());
  core.setProps({ label });

  if (!captureSource) {
    if (__DEV__) logMissingFeature(DISPLAY_NAME, selectCaptureSource.displayName ?? 'captureSource');
    return null;
  }

  core.setMedia(captureSource);
  const state = core.getState();
  const labelText = translateText(core.getLabel(state), translator);

  return renderElement(
    'div',
    { render, className, style },
    {
      state,
      stateAttrMap: CapturePlaceholderDataAttrs,
      ref: [forwardedRef],
      props: [
        {
          children: children ?? (labelText || undefined),
          ...elementProps,
          // Authored children carry the message themselves — an aria-label
          // here would announce the same guidance twice.
          'aria-label': children ? undefined : labelText || undefined,
        },
      ],
    }
  );
});

CapturePlaceholder.displayName = DISPLAY_NAME;

export namespace CapturePlaceholder {
  export type Props = CapturePlaceholderProps;
  export type State = CapturePlaceholderCore.State;
}
