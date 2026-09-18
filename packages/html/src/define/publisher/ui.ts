// Registers the video publisher, container, and all publisher UI custom
// elements without creating a skin element. Use this entry when building an
// ejected (light DOM) publisher layout for MoQ broadcast.

import { I18nProviderElement } from '../../i18n/provider-element';
import { VideoPublisherElement } from '../../presets/publisher/player';
import { safeDefine } from '../../registration/safe-define';
import { defineControls, defineErrorDialog, defineMenu, defineTooltip } from '../../registration/ui-compounds';
import { CameraButtonElement } from '../../ui/camera-button/camera-button-element';
import { CameraRadioGroupElement } from '../../ui/camera-radio-group/camera-radio-group-element';
import { CapturePlaceholderElement } from '../../ui/capture-placeholder/capture-placeholder-element';
import { ConnectionIndicatorElement } from '../../ui/connection-indicator/connection-indicator-element';
import { ContainerElement } from '../../ui/container/container-element';
import { EnableDevicesButtonElement } from '../../ui/enable-devices-button/enable-devices-button-element';
import { FullscreenButtonElement } from '../../ui/fullscreen-button/fullscreen-button-element';
import { HotkeyElement } from '../../ui/hotkey/hotkey-element';
import { MicButtonElement } from '../../ui/mic-button/mic-button-element';
import { MicRadioGroupElement } from '../../ui/mic-radio-group/mic-radio-group-element';
import { PopoverElement } from '../../ui/popover/popover-element';
import { PublishBadgeElement } from '../../ui/publish-badge/publish-badge-element';
import { PublishButtonElement } from '../../ui/publish-button/publish-button-element';
import { PublishTimerElement } from '../../ui/publish-timer/publish-timer-element';
import { ScreenShareButtonElement } from '../../ui/screen-share-button/screen-share-button-element';
import { TextElement } from '../../ui/text/text-element';

// ── Registration (providers / parents first) ────────────────────────────

safeDefine(VideoPublisherElement);
safeDefine(ContainerElement);
safeDefine(I18nProviderElement);

// Compound groups.
defineControls();
defineErrorDialog();
defineMenu();
defineTooltip();

// Standalone elements.
safeDefine(CameraButtonElement);
safeDefine(CameraRadioGroupElement);
safeDefine(CapturePlaceholderElement);
safeDefine(ConnectionIndicatorElement);
safeDefine(EnableDevicesButtonElement);
safeDefine(FullscreenButtonElement);
safeDefine(HotkeyElement);
safeDefine(MicButtonElement);
safeDefine(MicRadioGroupElement);
safeDefine(PopoverElement);
safeDefine(PublishBadgeElement);
safeDefine(PublishButtonElement);
safeDefine(PublishTimerElement);
safeDefine(ScreenShareButtonElement);
safeDefine(TextElement);
