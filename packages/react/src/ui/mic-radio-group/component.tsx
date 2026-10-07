'use client';

import { type MicRadioGroupCore, MicRadioGroupDataAttrs, type MenuOptionState } from '@videojs/core';
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
  type MicrophoneOption,
  type MicrophoneOptionsProps,
  type MicrophoneOptionsResult,
  useMicrophoneOptions,
} from './use-microphone-options';

export type MicRadioGroupItemState = MicrophoneOption & {
  /** Whether this option is currently selected. */
  checked: boolean;
};

export interface MicRadioGroupItemProps extends Omit<MenuRadioItemProps, 'ref'> {
  /** Microphone device ID represented by the item. */
  'data-device': string;
}

export interface MicRadioGroupRootProps extends MicrophoneOptionsProps {
  children?: ReactNode;
}

export interface MicRadioGroupOptionsProps extends Omit<UIComponentProps<'div', MicRadioGroupCore.State>, 'children'> {
  /** Render one consumer-owned menu radio item for every microphone. */
  renderItem: (props: MicRadioGroupItemProps, state: MicRadioGroupItemState) => ReactElement;
}

export type MicRadioGroupValueProps = UIComponentProps<'span', MicrophoneOptionsResult>;

const MicRadioGroupContext = createContext<MicrophoneOptionsResult | null | undefined>(undefined);

/** Owns microphone option state and shares it with an enclosing menu. Does not render a DOM element. */
export function MicRadioGroupRoot({ children, ...props }: MicRadioGroupRootProps): ReactNode {
  const microphones = useMicrophoneOptions(props);

  useMenuOptionState(toMenuOptionState(microphones));

  return <MicRadioGroupContext.Provider value={microphones}>{children}</MicRadioGroupContext.Provider>;
}

/** Displays the selected microphone label. */
export const MicRadioGroupValue = forwardRef<HTMLSpanElement, MicRadioGroupValueProps>(function MicRadioGroupValue(
  { render, className, style, ...elementProps },
  forwardedRef
) {
  const microphones = useMicRadioGroupContext();
  if (!microphones) return null;

  return renderElement(
    'span',
    { render, className, style },
    { state: microphones, ref: forwardedRef, props: [elementProps, { children: selectedLabel(microphones) }] }
  );
});

/** Renders menu radio items for the available microphones. */
export const MicRadioGroupOptions = forwardRef<HTMLDivElement, MicRadioGroupOptionsProps>(
  function MicRadioGroupOptions(componentProps, forwardedRef) {
    const {
      renderItem,
      render,
      className,
      style,
      'aria-label': ariaLabelProp,
      'aria-labelledby': ariaLabelledBy,
      ...elementProps
    } = componentProps;
    const microphones = useMicRadioGroupContext();
    if (!microphones) return null;

    const { state, value, options, setValue } = microphones;
    const ariaLabel = ariaLabelProp ?? (ariaLabelledBy === undefined ? microphones.label : undefined);

    return (
      <MenuRadioGroup
        {...getStateDataAttrs(state, MicRadioGroupDataAttrs)}
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

function useMicRadioGroupContext(): MicrophoneOptionsResult | null {
  const microphones = useContext(MicRadioGroupContext);
  if (microphones === undefined) throw new Error('MicRadioGroup parts must be used within MicRadioGroup.Root');

  return microphones;
}

function selectedLabel(microphones: MicrophoneOptionsResult): string {
  return microphones.options.find((option) => option.value === microphones.value)?.label ?? '';
}

/** Availability, not `hidden`, decides whether the trigger shows, matching `<media-mic-radio-group>`. */
function toMenuOptionState(microphones: MicrophoneOptionsResult | null): MenuOptionState {
  return {
    value: microphones ? selectedLabel(microphones) : '',
    disabled: microphones?.disabled ?? true,
    hidden: !microphones,
    availability: microphones?.state.availability ?? 'unsupported',
  };
}

export namespace MicRadioGroupRoot {
  export type Props = MicRadioGroupRootProps;
}

export namespace MicRadioGroupValue {
  export type Props = MicRadioGroupValueProps;
  export type State = MicrophoneOptionsResult;
}

export namespace MicRadioGroupOptions {
  export type Props = MicRadioGroupOptionsProps;
  export type State = MicRadioGroupCore.State;
  export type ItemProps = MicRadioGroupItemProps;
  export type ItemState = MicRadioGroupItemState;
}
