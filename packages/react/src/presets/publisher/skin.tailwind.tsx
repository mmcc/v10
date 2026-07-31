import { cameraText, enableDevicesText, microphoneText } from '@videojs/core/i18n/text/publish';
import {
  button,
  buttonGroup,
  capturePlaceholder,
  connectionIndicator,
  controls,
  error,
  icon,
  iconState,
  menu,
  overlay,
  popup,
  publishBadge,
  publishStatus,
  publishTimer,
  root,
  spacer,
} from '@videojs/skins/default/tailwind/publisher.tailwind';
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
import type { PublisherSkinProps } from './skin';

const Button = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(function Button({ className, ...props }, ref) {
  return (
    <button ref={ref} type="button" className={cn(button.base, button.subtle, button.icon, className)} {...props} />
  );
});

/** Chevron trigger + device picker menu shared by the camera and mic pickers. */
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
      <Menu.Trigger aria-label={label} disabled={disabled} render={<Button />}>
        <ChevronIcon className={icon} />
      </Menu.Trigger>
      <Menu.Content className={cn(popup.popover, menu.root)}>
        <Menu.RadioGroup className={menu.group} value={value} onValueChange={setValue} aria-label={label}>
          {options.map((option) => (
            <Menu.RadioItem key={option.value} className={menu.item} value={option.value} disabled={option.disabled}>
              <span>{option.label}</span>
              <Menu.ItemIndicator checked={option.value === value} forceMount className={menu.indicator}>
                <CheckIcon className={cn(icon, menu.icon)} />
              </Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}

function CameraMenu(): ReactNode {
  const t = useTranslator();
  const cameras = useCameraOptions();
  // Hide the picker when there is no camera choice to make.
  if (!cameras?.showMenu) return null;

  return (
    <DeviceMenu
      label={t(cameraText)}
      options={cameras.options}
      disabled={cameras.disabled}
      value={cameras.value}
      setValue={cameras.setValue}
    />
  );
}

function MicrophoneMenu(): ReactNode {
  const t = useTranslator();
  const microphones = useMicrophoneOptions();
  // Hide the picker when there is no microphone choice to make.
  if (!microphones?.showMenu) return null;

  return (
    <DeviceMenu
      label={t(microphoneText)}
      options={microphones.options}
      disabled={microphones.disabled}
      value={microphones.value}
      setValue={microphones.setValue}
    />
  );
}

/**
 * Tailwind twin of {@link PublisherSkin} — the same structure styled with the
 * publisher Tailwind vocabulary instead of the stylesheet class contract.
 */
export function PublisherSkinTailwind(props: PublisherSkinProps): ReactNode {
  const { children, className, style, ...rest } = props;
  const t = useTranslator();

  return (
    <Container className={cn(root(false), className)} style={style} {...rest}>
      {children}

      <CapturePlaceholder className={capturePlaceholder.root}>
        <div className={capturePlaceholder.content}>
          <CameraIcon className={cn(icon, capturePlaceholder.icon)} />
          {/* Nested placeholder (without the root classes) renders the state-driven message text. */}
          <CapturePlaceholder className={capturePlaceholder.message} />
          <EnableDevicesButton className={cn(button.base, button.enableDevices)}>
            {t(enableDevicesText)}
          </EnableDevicesButton>
        </div>
      </CapturePlaceholder>

      <div className={publishStatus}>
        <PublishBadge className={publishBadge} />
        <PublishTimer className={publishTimer} />
        <ConnectionIndicator className={connectionIndicator}>
          <SignalIcon className={icon} />
        </ConnectionIndicator>
      </div>

      <ErrorDialog.Root>
        <ErrorDialog.Popup className={error.root}>
          <div className={error.dialog}>
            <div className={error.content}>
              <ErrorDialog.Title className={error.title} />
              <ErrorDialog.Description className={error.description} />
            </div>
            <div className={error.actions}>
              <ErrorDialog.Close className={cn(button.base, button.primary)} />
            </div>
          </div>
        </ErrorDialog.Popup>
      </ErrorDialog.Root>

      <Controls.Root className={controls}>
        <Tooltip.Provider>
          <div className={buttonGroup}>
            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <CameraButton className={iconState.camera.button} render={<Button />}>
                    <CameraIcon className={cn(icon, iconState.camera.on)} />
                    <CameraOffIcon className={cn(icon, iconState.camera.off)} />
                  </CameraButton>
                }
              />
              <Tooltip.Popup className={cn(popup.tooltip)}>
                <Tooltip.Label />
                <Tooltip.Shortcut className={popup.tooltipShortcut} />
              </Tooltip.Popup>
            </Tooltip.Root>

            <CameraMenu />

            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <MicButton className={iconState.mic.button} render={<Button />}>
                    <MicIcon className={cn(icon, iconState.mic.on)} />
                    <MicOffIcon className={cn(icon, iconState.mic.off)} />
                  </MicButton>
                }
              />
              <Tooltip.Popup className={cn(popup.tooltip)}>
                <Tooltip.Label />
                <Tooltip.Shortcut className={popup.tooltipShortcut} />
              </Tooltip.Popup>
            </Tooltip.Root>

            <MicrophoneMenu />

            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <ScreenShareButton className={button.screenShare} render={<Button />}>
                    <ScreenShareIcon className={icon} />
                  </ScreenShareButton>
                }
              />
              <Tooltip.Popup className={cn(popup.tooltip)}>
                <Tooltip.Label />
                <Tooltip.Shortcut className={popup.tooltipShortcut} />
              </Tooltip.Popup>
            </Tooltip.Root>
          </div>

          <div className={spacer} aria-hidden="true" />

          <div className={buttonGroup}>
            <PublishButton className={cn(button.base, button.publish)} />

            <Tooltip.Root side="top">
              <Tooltip.Trigger
                render={
                  <FullscreenButton className={iconState.fullscreen.button} render={<Button />}>
                    <FullscreenEnterIcon className={cn(icon, iconState.fullscreen.enter)} />
                    <FullscreenExitIcon className={cn(icon, iconState.fullscreen.exit)} />
                  </FullscreenButton>
                }
              />
              <Tooltip.Popup className={cn(popup.tooltip)}>
                <Tooltip.Label />
                <Tooltip.Shortcut className={popup.tooltipShortcut} />
              </Tooltip.Popup>
            </Tooltip.Root>
          </div>
        </Tooltip.Provider>
      </Controls.Root>

      <div className={overlay} />

      {/* Hotkeys */}
      <Hotkey keys="m" action="toggleMicMuted" />
      <Hotkey keys="v" action="toggleCameraMuted" />
      <Hotkey keys="f" action="toggleFullscreen" />
    </Container>
  );
}
