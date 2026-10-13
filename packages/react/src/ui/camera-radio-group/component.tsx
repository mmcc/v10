'use client';

import { type CameraRadioGroupCore, CameraRadioGroupDataAttrs, type MenuOptionState } from '@videojs/core';
import { getStateDataAttrs } from '@videojs/core/dom';
import { isFunction } from '@videojs/utils/predicate';
import type { ReactElement, ReactNode } from 'react';
import { createContext, Fragment, forwardRef, useContext } from 'react';

import type { HTMLProps, UIComponentProps } from '../../utils/types';
import { renderElement } from '../../utils/use-render';
import { useMenuOptionState } from '../menu/context';
import { MenuRadioGroup } from '../menu/radio-group';
import type { MenuRadioItemProps } from '../menu/radio-item';
import {
  type CameraOption,
  type CameraOptionsProps,
  type CameraOptionsResult,
  useCameraOptions,
} from './use-camera-options';

export type CameraRadioGroupItemState = CameraOption & {
  /** Whether this option is currently selected. */
  checked: boolean;
};

export interface CameraRadioGroupItemProps extends Omit<MenuRadioItemProps, 'ref'> {
  /** Camera device ID represented by the item. */
  'data-device': string;
}

export interface CameraRadioGroupRootProps extends CameraOptionsProps {
  children?: ReactNode;
}

export interface CameraRadioGroupOptionsProps extends Omit<
  UIComponentProps<'div', CameraRadioGroupCore.State>,
  'children'
> {
  /** Render one consumer-owned menu radio item for every camera. */
  renderItem: (props: CameraRadioGroupItemProps, state: CameraRadioGroupItemState) => ReactElement;
}

export type CameraRadioGroupValueProps = UIComponentProps<'span', CameraOptionsResult>;

const CameraRadioGroupContext = createContext<CameraOptionsResult | null | undefined>(undefined);

/** Owns camera option state and shares it with an enclosing menu. Does not render a DOM element. */
export function CameraRadioGroupRoot({ children, ...props }: CameraRadioGroupRootProps): ReactNode {
  const cameras = useCameraOptions(props);

  useMenuOptionState(toMenuOptionState(cameras));

  return <CameraRadioGroupContext.Provider value={cameras}>{children}</CameraRadioGroupContext.Provider>;
}

/** Displays the selected camera label. */
export const CameraRadioGroupValue = forwardRef<HTMLSpanElement, CameraRadioGroupValueProps>(
  function CameraRadioGroupValue({ render, className, style, ...elementProps }, forwardedRef) {
    const cameras = useCameraRadioGroupContext();
    if (!cameras) return null;

    return renderElement(
      'span',
      { render, className, style },
      { state: cameras, ref: forwardedRef, props: [elementProps, { children: selectedLabel(cameras) }] }
    );
  }
);

/** Renders menu radio items for the available cameras. */
export const CameraRadioGroupOptions = forwardRef<HTMLDivElement, CameraRadioGroupOptionsProps>(
  function CameraRadioGroupOptions(componentProps, forwardedRef) {
    const {
      renderItem,
      render,
      className,
      style,
      'aria-label': ariaLabelProp,
      'aria-labelledby': ariaLabelledBy,
      ...elementProps
    } = componentProps;
    const cameras = useCameraRadioGroupContext();
    if (!cameras) return null;

    const { state, value, options, setValue } = cameras;
    const ariaLabel = ariaLabelProp ?? (ariaLabelledBy === undefined ? cameras.label : undefined);

    return (
      <MenuRadioGroup
        {...getStateDataAttrs(state, CameraRadioGroupDataAttrs)}
        {...elementProps}
        ref={forwardedRef}
        className={isFunction(className) ? className(state) : className}
        style={isFunction(style) ? style(state) : style}
        render={isFunction(render) ? (props: HTMLProps) => render(props, state) : render}
        value={value}
        onValueChange={setValue}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={state.disabled || undefined}
      >
        {options.map((option) => {
          const itemState = { ...option, checked: option.value === value };

          return (
            <Fragment key={option.value}>
              {renderItem(
                {
                  value: option.value,
                  disabled: option.disabled,
                  'data-device': option.value,
                  children: option.label,
                },
                itemState
              )}
            </Fragment>
          );
        })}
      </MenuRadioGroup>
    );
  }
);

function useCameraRadioGroupContext(): CameraOptionsResult | null {
  const cameras = useContext(CameraRadioGroupContext);
  if (cameras === undefined) throw new Error('CameraRadioGroup parts must be used within CameraRadioGroup.Root');

  return cameras;
}

function selectedLabel(cameras: CameraOptionsResult): string {
  return cameras.options.find((option) => option.value === cameras.value)?.label ?? '';
}

/** Availability, not `hidden`, decides whether the trigger shows, matching `<media-camera-radio-group>`. */
function toMenuOptionState(cameras: CameraOptionsResult | null): MenuOptionState {
  return {
    value: cameras ? selectedLabel(cameras) : '',
    disabled: cameras?.disabled ?? true,
    hidden: !cameras,
    availability: cameras?.state.availability ?? 'unsupported',
  };
}

export namespace CameraRadioGroupRoot {
  export type Props = CameraRadioGroupRootProps;
}

export namespace CameraRadioGroupValue {
  export type Props = CameraRadioGroupValueProps;
  export type State = CameraOptionsResult;
}

export namespace CameraRadioGroupOptions {
  export type Props = CameraRadioGroupOptionsProps;
  export type State = CameraRadioGroupCore.State;
  export type ItemProps = CameraRadioGroupItemProps;
  export type ItemState = CameraRadioGroupItemState;
}
