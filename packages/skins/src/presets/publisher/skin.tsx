import { enableDevicesText } from '@videojs/core/i18n/text/publish';
import * as $ from '@videojs/core/vjsc';
import { CameraIcon, SignalIcon } from '@videojs/icons/vjsc';
import { Box, type PropsOf, Slot, Text, type VjscNode } from 'vjsc/components';

import { Button } from '../../components/buttons/button';
import { ButtonTooltip } from '../../components/buttons/button-tooltip';
import { FullscreenButton } from '../../components/buttons/fullscreen-button';
import { ErrorDialog } from '../../components/dialogs/error-dialog';
import { Container } from '../../components/layout/container';
import { CameraControl, MicControl, ScreenShareButton } from './capture-controls';
import styles from './publisher.styles';

export interface PublisherSkinProps extends Omit<PropsOf<typeof Container>, 'children'> {
  children?: VjscNode;
}

/**
 * MoQ broadcast UI: a capture placeholder over the local preview, a status capsule (badge, timer, connection), the
 * error dialog, and an always-visible controls bar with camera and mic split controls, screen share, and Go live.
 */
export function PublisherSkin({ children, className, ...props }: PublisherSkinProps = {}) {
  return (
    <Container className={[styles.root, className]} data-theme="default" data-preset="publisher" {...props}>
      <Slot>{children}</Slot>
      <CapturePlaceholder />
      <PublishStatus />
      <ErrorDialog />
      <PublisherControls />
      <$.Hotkey keys="m" action="toggleMicMuted" />
      <$.Hotkey keys="v" action="toggleCameraMuted" />
      <$.Hotkey keys="f" action="toggleFullscreen" />
    </Container>
  );
}

function CapturePlaceholder() {
  return (
    <$.CapturePlaceholder className={[styles.placeholder.root, styles.placeholder.group]}>
      <Box className={styles.placeholder.content}>
        <CameraIcon className={styles.placeholder.icon} />
        {/* The nested placeholder renders the state-driven message text. */}
        <$.CapturePlaceholder className={styles.placeholder.message} />
        <$.EnableDevicesButton $render={Button} className={styles.placeholder.enableButton}>
          <Text token={enableDevicesText.key}>{enableDevicesText.text}</Text>
        </$.EnableDevicesButton>
      </Box>
    </$.CapturePlaceholder>
  );
}

function PublishStatus() {
  return (
    <Box className={styles.status.root}>
      <$.PublishBadge className={styles.status.badge} />
      <$.PublishTimer className={styles.status.timer} />
      <$.ConnectionIndicator className={styles.status.connection}>
        <SignalIcon className={styles.status.icon} />
      </$.ConnectionIndicator>
    </Box>
  );
}

function PublisherControls() {
  return (
    <$.Controls.Root visibility="always">
      <$.Controls.Backdrop className={styles.controls.backdrop} />
      <$.Controls.Content className={styles.controls.content}>
        <$.Tooltip.Provider>
          <Box className={[styles.controls.group, styles.controls.devices]}>
            <CameraControl />
            <MicControl />
            <ScreenShareButton />
          </Box>
          <Box aria-hidden="true" className={styles.controls.spacer} />
          <Box className={styles.controls.group}>
            <$.PublishButton $render={Button} className={styles.publishButton} />
            <ButtonTooltip side="top">
              <FullscreenButton />
            </ButtonTooltip>
          </Box>
        </$.Tooltip.Provider>
      </$.Controls.Content>
    </$.Controls.Root>
  );
}
