import { cameraText, enableDevicesText, microphoneText } from '@videojs/core/i18n/text/publish';
import { cn } from '@videojs/utils/style';
import { type ComponentProps, forwardRef, type ReactNode } from 'react';

import { useTranslator } from '@/i18n/context';
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  ChevronIcon,
  FullscreenEnterIcon,
  FullscreenExitIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  SignalIcon,
} from '@/icons';
import { Container } from '@/player/container';
import { CameraButton } from '@/ui/camera-button';
import { useCameraOptions } from '@/ui/camera-radio-group';
import { CapturePlaceholder } from '@/ui/capture-placeholder';
import { ConnectionIndicator } from '@/ui/connection-indicator';
import { Controls } from '@/ui/controls';
import { EnableDevicesButton } from '@/ui/enable-devices-button';
import { ErrorDialog } from '@/ui/error-dialog';
import { FullscreenButton } from '@/ui/fullscreen-button';
import { Hotkey } from '@/ui/hotkey';
import { Menu } from '@/ui/menu';
import { MicButton } from '@/ui/mic-button';
import { useMicrophoneOptions } from '@/ui/mic-radio-group';
import { PublishBadge } from '@/ui/publish-badge';
import { PublishButton } from '@/ui/publish-button';
import { PublishTimer } from '@/ui/publish-timer';
import { ScreenShareButton } from '@/ui/screen-share-button';
import { Tooltip } from '@/ui/tooltip';

import type { BaseSkinProps } from '../types';

export type PublisherSkinProps = BaseSkinProps;

const Button = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(function Button({ className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn('media-button media-button--subtle media-button--icon', className)}
      {...props}
    />
  );
});

/** Caret segment of a device split control — subtle, but without the square `--icon` sizing. */
const CaretButton = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(function CaretButton(
  { className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn('media-button media-button--subtle media-device-control__caret', className)}
      {...props}
    />
  );
});

/** Caret trigger + device picker menu shared by the camera and mic controls. */
function DeviceMenu({
  label,
  options,
  disabled,
  value,
  setValue,
}: {
  label: string;
  options: { value: string; label: string; disabled: boolean }[];
  disabled: boolean;
  value: string;
  setValue: (value: string) => void;
}): ReactNode {
  return (
    <Menu.Root side="top" align="center">
      <Menu.Trigger aria-label={label} disabled={disabled} render={<CaretButton />}>
        <ChevronIcon className="media-icon" />
      </Menu.Trigger>
      <Menu.Popup className="media-surface media-popover media-menu">
        <Menu.Content className="media-menu__content">
          <Menu.RadioGroup className="media-menu__group" value={value} onValueChange={setValue} aria-label={label}>
            {options.map((option) => (
              <Menu.RadioItem
                key={option.value}
                className="media-menu__item"
                value={option.value}
                disabled={option.disabled}
              >
                <span>{option.label}</span>
                <Menu.ItemIndicator checked={option.value === value} forceMount className="media-menu__indicator">
                  <CheckIcon className="media-icon" />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  );
}

/**
 * Camera toggle fused with its source picker into one split control, so the caret plainly belongs to the camera rather
 * than floating between toggles. The toggle keeps its own tooltip and hotkey hint.
 */
function CameraControl(): ReactNode {
  const t = useTranslator();
  const cameras = useCameraOptions();

  return (
    <div className="media-device-control">
      <Tooltip.Root side="top">
        <Tooltip.Trigger
          render={
            <CameraButton className="media-button--camera" render={<Button />}>
              <CameraIcon className="media-icon media-icon--camera" />
              <CameraOffIcon className="media-icon media-icon--camera-off" />
            </CameraButton>
          }
        />
        <Tooltip.Popup className="media-surface media-tooltip">
          <Tooltip.Label />
          <Tooltip.Shortcut className="media-tooltip__kbd" />
        </Tooltip.Popup>
      </Tooltip.Root>

      {/* Omit the caret when there is no camera choice to make. */}
      {cameras?.showMenu ? (
        <DeviceMenu
          label={t(cameraText)}
          options={cameras.options}
          disabled={cameras.disabled}
          value={cameras.value}
          setValue={cameras.setValue}
        />
      ) : null}
    </div>
  );
}

/** Microphone twin of {@link CameraControl}. */
function MicControl(): ReactNode {
  const t = useTranslator();
  const microphones = useMicrophoneOptions();

  return (
    <div className="media-device-control">
      <Tooltip.Root side="top">
        <Tooltip.Trigger
          render={
            <MicButton className="media-button--mic" render={<Button />}>
              <MicIcon className="media-icon media-icon--mic" />
              <MicOffIcon className="media-icon media-icon--mic-off" />
            </MicButton>
          }
        />
        <Tooltip.Popup className="media-surface media-tooltip">
          <Tooltip.Label />
          <Tooltip.Shortcut className="media-tooltip__kbd" />
        </Tooltip.Popup>
      </Tooltip.Root>

      {/* Omit the caret when there is no microphone choice to make. */}
      {microphones?.showMenu ? (
        <DeviceMenu
          label={t(microphoneText)}
          options={microphones.options}
          disabled={microphones.disabled}
          value={microphones.value}
          setValue={microphones.setValue}
        />
      ) : null}
    </div>
  );
}

/**
 * Default publisher skin. Mirrors the HTML `<publisher-skin>` template: a capture placeholder over the preview, a
 * publish status row (badge, timer, connection indicator), an error dialog, and an always-visible controls bar with
 * camera/mic split controls, screen share, and the publish button.
 */
export function PublisherSkin(props: PublisherSkinProps): ReactNode {
  const { children, className, style, ...rest } = props;
  const t = useTranslator();

  return (
    <Container className={cn('media-default-skin media-default-skin--publisher', className)} style={style} {...rest}>
      {children}

      <CapturePlaceholder className="media-capture-placeholder">
        <div className="media-capture-placeholder__content">
          <CameraIcon className="media-icon media-capture-placeholder__icon" />
          {/* Nested placeholder (without the root class) renders the state-driven message text. */}
          <CapturePlaceholder className="media-capture-placeholder__message" />
          <EnableDevicesButton className="media-button media-button--enable-devices">
            {t(enableDevicesText)}
          </EnableDevicesButton>
        </div>
      </CapturePlaceholder>

      <div className="media-publish-status">
        <PublishBadge className="media-badge media-badge--publish" />
        <PublishTimer className="media-publish-timer" />
        <ConnectionIndicator className="media-connection-indicator">
          <SignalIcon className="media-icon media-icon--signal" />
        </ConnectionIndicator>
      </div>

      <ErrorDialog.Root>
        <ErrorDialog.Backdrop className="media-dialog__backdrop" />
        <ErrorDialog.Popup className="media-dialog__popup media-surface">
          <div className="media-dialog__content">
            <ErrorDialog.Title className="media-dialog__title" />
            <ErrorDialog.Description className="media-dialog__description" />
          </div>
          <div className="media-dialog__actions">
            <ErrorDialog.Close className="media-button media-button--primary" />
          </div>
        </ErrorDialog.Popup>
      </ErrorDialog.Root>

      <Controls.Root>
        <Controls.Backdrop className="media-controls__backdrop" />
        <Controls.Content className="media-surface media-controls media-controls--root">
          <Tooltip.Provider>
            <div className="media-button-group media-button-group--devices">
              <CameraControl />
              <MicControl />

              <Tooltip.Root side="top">
                <Tooltip.Trigger
                  render={
                    <ScreenShareButton className="media-button--screen-share" render={<Button />}>
                      <ScreenShareIcon className="media-icon media-icon--screen-share" />
                    </ScreenShareButton>
                  }
                />
                <Tooltip.Popup className="media-surface media-tooltip">
                  <Tooltip.Label />
                  <Tooltip.Shortcut className="media-tooltip__kbd" />
                </Tooltip.Popup>
              </Tooltip.Root>
            </div>

            <div className="media-controls__spacer" aria-hidden="true" />

            <div className="media-button-group">
              <PublishButton className="media-button media-button--publish" />

              <Tooltip.Root side="top">
                <Tooltip.Trigger
                  render={
                    <FullscreenButton className="media-button--fullscreen" render={<Button />}>
                      <FullscreenEnterIcon className="media-icon media-icon--fullscreen-enter" />
                      <FullscreenExitIcon className="media-icon media-icon--fullscreen-exit" />
                    </FullscreenButton>
                  }
                />
                <Tooltip.Popup className="media-surface media-tooltip">
                  <Tooltip.Label />
                  <Tooltip.Shortcut className="media-tooltip__kbd" />
                </Tooltip.Popup>
              </Tooltip.Root>
            </div>
          </Tooltip.Provider>
        </Controls.Content>
      </Controls.Root>

      {/* Hotkeys */}
      <Hotkey keys="m" action="toggleMicMuted" />
      <Hotkey keys="v" action="toggleCameraMuted" />
      <Hotkey keys="f" action="toggleFullscreen" />
    </Container>
  );
}
