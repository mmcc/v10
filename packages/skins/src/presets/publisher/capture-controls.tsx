import { cameraText, microphoneText } from '@videojs/core/i18n/text/publish';
import * as $ from '@videojs/core/vjsc';
import { CameraIcon, CameraOffIcon, ChevronIcon, MicIcon, MicOffIcon, ScreenShareIcon } from '@videojs/icons/vjsc';
import { Box, Template, Text } from 'vjsc/components';

import { Button } from '../../components/buttons/button';
import { ButtonTooltip } from '../../components/buttons/button-tooltip';
import { RadioItem } from '../../components/menus/radio-item';
import buttonStyles from '../../styles/buttons/button.styles';
import menuStyles from '../../styles/menus/menu.styles';
import popupStyles from '../../styles/popups/popup.styles';
import styles from './publisher.styles';

/**
 * Camera toggle fused with its source picker, so the caret plainly belongs to the camera rather than floating between
 * toggles. The radio group's availability hides the caret when there is no choice to make.
 */
export function CameraControl() {
  return (
    <Box className={styles.device.root}>
      <ButtonTooltip side="top">
        <$.CameraButton $render={Button} className={styles.capture.root}>
          <CameraIcon className={[buttonStyles.iconBase, styles.capture.onIcon]} />
          <CameraOffIcon className={[buttonStyles.iconBase, styles.capture.offIcon]} />
        </$.CameraButton>
      </ButtonTooltip>
      <$.Menu.Root side="top" align="center" boundary="viewport">
        <$.CameraRadioGroup.Root>
          <$.Menu.Trigger className={[buttonStyles.root, styles.device.caret]}>
            <ChevronIcon className={styles.device.caretIcon} />
            <Text token={cameraText.key} className={styles.device.caretLabel}>
              {cameraText.text}
            </Text>
          </$.Menu.Trigger>
          <$.Menu.Popup className={[popupStyles.popup, popupStyles.surface, menuStyles.popup]}>
            <$.Menu.Content className={menuStyles.content}>
              <$.CameraRadioGroup.Options className={menuStyles.radioGroup}>
                <Template name="camera-option">
                  <RadioItem>
                    <Template.Part name="label" />
                  </RadioItem>
                </Template>
              </$.CameraRadioGroup.Options>
            </$.Menu.Content>
          </$.Menu.Popup>
        </$.CameraRadioGroup.Root>
      </$.Menu.Root>
    </Box>
  );
}

/** Microphone twin of {@link CameraControl}. */
export function MicControl() {
  return (
    <Box className={styles.device.root}>
      <ButtonTooltip side="top">
        <$.MicButton $render={Button} className={styles.capture.root}>
          <MicIcon className={[buttonStyles.iconBase, styles.capture.onIcon]} />
          <MicOffIcon className={[buttonStyles.iconBase, styles.capture.offIcon]} />
        </$.MicButton>
      </ButtonTooltip>
      <$.Menu.Root side="top" align="center" boundary="viewport">
        <$.MicRadioGroup.Root>
          <$.Menu.Trigger className={[buttonStyles.root, styles.device.caret]}>
            <ChevronIcon className={styles.device.caretIcon} />
            <Text token={microphoneText.key} className={styles.device.caretLabel}>
              {microphoneText.text}
            </Text>
          </$.Menu.Trigger>
          <$.Menu.Popup className={[popupStyles.popup, popupStyles.surface, menuStyles.popup]}>
            <$.Menu.Content className={menuStyles.content}>
              <$.MicRadioGroup.Options className={menuStyles.radioGroup}>
                <Template name="mic-option">
                  <RadioItem>
                    <Template.Part name="label" />
                  </RadioItem>
                </Template>
              </$.MicRadioGroup.Options>
            </$.Menu.Content>
          </$.Menu.Popup>
        </$.MicRadioGroup.Root>
      </$.Menu.Root>
    </Box>
  );
}

export function ScreenShareButton() {
  return (
    <ButtonTooltip side="top">
      <$.ScreenShareButton $render={Button} className={styles.screenShare}>
        <ScreenShareIcon className={buttonStyles.iconBase} />
      </$.ScreenShareButton>
    </ButtonTooltip>
  );
}
