'use client';

import { PublishButtonCore, PublishButtonDataAttrs, type PublishButtonMediaState } from '@videojs/core';
import { logMissingFeature, selectCaptureSource, selectPublish } from '@videojs/core/dom';
import { translateText } from '@videojs/core/i18n';
import { forwardRef, type ReactNode, useLayoutEffect, useState } from 'react';

import { useTranslator } from '../../i18n/context';
import { usePlayer } from '../../player/context';
import type { UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';
import { useButton } from '../hooks/use-button';
import { useOptionalTooltipContext } from '../tooltip/context';

const DISPLAY_NAME = 'PublishButton';

export interface PublishButtonProps
  extends UIComponentProps<'button', PublishButtonCore.State>, PublishButtonCore.Props {}

/**
 * A button that starts and stops a publish (broadcast) session. Disabled while capture is inactive or the session is
 * transitioning, and exposes `data-publish-state` / `data-disabled` so skins can style the "Go live" ↔ "Stop stream"
 * treatment.
 *
 * Selects from the `publish` and `captureSource` features and composes them itself rather than going through
 * `createMediaButton`, since the PublishButton needs both slices to know whether a session can start.
 *
 * Displays the translated session label ("Go live" ↔ "Stop stream") when no children are provided.
 *
 * @example
 *   ```tsx
 *   <PublishButton />;
 *   ```;
 */
export const PublishButton = forwardRef<HTMLButtonElement, PublishButtonProps>(
  function PublishButton(componentProps, forwardedRef): ReactNode {
    const { children, render, className, style, label, disabled, ...elementProps } = componentProps;

    const publish = usePlayer(selectPublish);
    const captureSource = usePlayer(selectCaptureSource);

    const media: PublishButtonMediaState | null =
      publish && captureSource
        ? {
            publishState: publish.publishState,
            publishStartedAt: publish.publishStartedAt,
            publishError: publish.publishError,
            publish: publish.publish,
            unpublish: publish.unpublish,
            cameraState: captureSource.cameraState,
            screenShareState: captureSource.screenShareState,
            micState: captureSource.micState,
            micExplicit: captureSource.micExplicit,
          }
        : null;

    const tooltipCtx = useOptionalTooltipContext();
    const translator = useTranslator();
    const [core] = useState(() => new PublishButtonCore());

    core.setProps({ label, disabled });

    const { getButtonProps, buttonRef } = useButton({
      displayName: DISPLAY_NAME,
      onActivate: () => {
        // Fire-and-forget: failures surface through the `publish` feature state.
        if (media) void core.toggle(media);
      },
      isDisabled: () => !!disabled || !media,
    });

    if (media) core.setMedia(media);

    const state = media ? core.getState() : null;
    const labelText = state ? translateText(core.getLabel(state), translator) : undefined;

    useLayoutEffect(() => {
      if (!tooltipCtx) return;

      tooltipCtx.setContent(labelText ? { label: labelText } : undefined);
      return () => tooltipCtx.setContent(undefined);
    }, [tooltipCtx, labelText]);

    if (!media || !state) {
      if (__DEV__) logMissingFeature(DISPLAY_NAME, selectPublish.displayName ?? 'publish');

      return null;
    }

    const attrs = core.getAttrs(state);
    const labelAttr = attrs['aria-label'];
    // The default label follows the session ("Go live" ↔ "Stop stream").
    const content = children ?? labelText;

    return renderElement(
      'button',
      { render, className, style },
      {
        state,
        stateAttrMap: PublishButtonDataAttrs,
        ref: [forwardedRef, buttonRef],
        props: [
          attrs,
          {
            children: content,
            ...elementProps,
            'aria-label': labelAttr ? translateText(labelAttr, translator) : labelAttr,
          },
          getButtonProps(),
        ],
      }
    );
  }
);

PublishButton.displayName = DISPLAY_NAME;

export namespace PublishButton {
  export type Props = PublishButtonProps;
  export type State = PublishButtonCore.State;
}
