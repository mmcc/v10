import { cameraText, enableDevicesText, microphoneText } from '@videojs/core/i18n/text/publish';
import { renderIcon } from '@videojs/icons/render';
import {
  button,
  buttonGroup,
  capturePlaceholder,
  connectionIndicator,
  controls,
  deviceControl,
  deviceGroup,
  dialog,
  icon,
  iconState,
  menu,
  controlsBackdrop,
  popup,
  publishBadge,
  publishStatus,
  publishTimer,
  root,
  spacer,
} from '@videojs/skins/default/tailwind/publisher.tailwind';
import { createTemplate } from '@videojs/utils/dom';
import { cn } from '@videojs/utils/style';

import { renderText } from '../../i18n/render-text';
import { SkinElement } from '../skin';

function getTemplateHTML() {
  return /*html*/ `
    <media-container class="${root(true)}">
      <!-- @deprecated slot="media" is no longer required, use the default slot instead -->
      <slot name="media"></slot>
      <slot></slot>

      <media-capture-placeholder class="${capturePlaceholder.root}">
        <div class="${capturePlaceholder.content}">
          ${renderIcon('camera', { class: cn(icon, capturePlaceholder.icon) })}
          <!-- Nested placeholder (without the root classes) renders the state-driven message text. -->
          <media-capture-placeholder class="${capturePlaceholder.message}"></media-capture-placeholder>
          <media-enable-devices-button class="${cn(button.base, button.enableDevices)}">
            ${renderText(enableDevicesText)}
          </media-enable-devices-button>
        </div>
      </media-capture-placeholder>

      <div class="${publishStatus}">
        <media-publish-badge class="${publishBadge}"></media-publish-badge>
        <media-publish-timer class="${publishTimer}"></media-publish-timer>
        <media-connection-indicator class="${connectionIndicator}">
          ${renderIcon('signal', { class: icon })}
        </media-connection-indicator>
      </div>

      <media-error-dialog class="${dialog.root}">
        <media-dialog-backdrop class="${dialog.backdrop}"></media-dialog-backdrop>
        <media-dialog-popup class="${dialog.popup}">
          <div class="${dialog.content}">
            <media-dialog-title class="${dialog.title}"></media-dialog-title>
            <media-dialog-description class="${dialog.description}"></media-dialog-description>
          </div>
          <div class="${dialog.actions}">
            <media-dialog-close class="${cn(button.base, button.primary)}"></media-dialog-close>
          </div>
        </media-dialog-popup>
      </media-error-dialog>

      <media-controls>
        <media-controls-backdrop class="${controlsBackdrop}"></media-controls-backdrop>
        <media-controls-content class="${controls}">
          <media-tooltip-group>
            <div class="${deviceGroup}">
              <!-- Camera toggle fused with its source picker: the caret plainly
                   belongs to the camera instead of floating between toggles. The
                   caret must stay the menu's previous sibling — deviceControl.caret
                   hides it from there when there is no device choice to make. -->
              <div class="${deviceControl.root}">
                <media-camera-button commandfor="camera-tooltip" class="${cn(button.base, button.subtle, button.icon, iconState.camera.button)}">
                  ${renderIcon('camera', { class: cn(icon, iconState.camera.on) })}
                  ${renderIcon('camera-off', { class: cn(icon, iconState.camera.off) })}
                </media-camera-button>
                <media-tooltip id="camera-tooltip" side="top" class="${cn(popup.tooltip)}">
                  <media-tooltip-label></media-tooltip-label>
                  <media-tooltip-shortcut class="${popup.tooltipShortcut}"></media-tooltip-shortcut>
                </media-tooltip>

                <button commandfor="camera-menu" aria-labelledby="camera-menu-label" class="${cn(button.base, button.subtle, deviceControl.caret)}">
                  ${renderIcon('chevron', { class: cn(icon, deviceControl.caretIcon) })}
                  ${renderText(cameraText, { id: 'camera-menu-label', class: 'sr-only' })}
                </button>
                <media-menu id="camera-menu" side="top" align="center" class="${cn(popup.popover, menu.root)}">
                  <media-menu-content class="${menu.content}">
                    <media-camera-radio-group class="${menu.group}">
                      <template>
                        <media-menu-radio-item class="${menu.item}">
                          <span data-part="label"></span>
                          <media-menu-item-indicator force-mount class="${menu.indicator}">
                            ${renderIcon('check', { class: cn(icon, menu.icon) })}
                          </media-menu-item-indicator>
                        </media-menu-radio-item>
                      </template>
                    </media-camera-radio-group>
                  </media-menu-content>
                </media-menu>
              </div>

              <div class="${deviceControl.root}">
                <media-mic-button commandfor="mic-tooltip" class="${cn(button.base, button.subtle, button.icon, iconState.mic.button)}">
                  ${renderIcon('mic', { class: cn(icon, iconState.mic.on) })}
                  ${renderIcon('mic-off', { class: cn(icon, iconState.mic.off) })}
                </media-mic-button>
                <media-tooltip id="mic-tooltip" side="top" class="${cn(popup.tooltip)}">
                  <media-tooltip-label></media-tooltip-label>
                  <media-tooltip-shortcut class="${popup.tooltipShortcut}"></media-tooltip-shortcut>
                </media-tooltip>

                <button commandfor="mic-menu" aria-labelledby="mic-menu-label" class="${cn(button.base, button.subtle, deviceControl.caret)}">
                  ${renderIcon('chevron', { class: cn(icon, deviceControl.caretIcon) })}
                  ${renderText(microphoneText, { id: 'mic-menu-label', class: 'sr-only' })}
                </button>
                <media-menu id="mic-menu" side="top" align="center" class="${cn(popup.popover, menu.root)}">
                  <media-menu-content class="${menu.content}">
                    <media-mic-radio-group class="${menu.group}">
                      <template>
                        <media-menu-radio-item class="${menu.item}">
                          <span data-part="label"></span>
                          <media-menu-item-indicator force-mount class="${menu.indicator}">
                            ${renderIcon('check', { class: cn(icon, menu.icon) })}
                          </media-menu-item-indicator>
                        </media-menu-radio-item>
                      </template>
                    </media-mic-radio-group>
                  </media-menu-content>
                </media-menu>
              </div>

              <media-screen-share-button commandfor="screen-share-tooltip" class="${cn(button.base, button.subtle, button.icon, button.screenShare)}">
                ${renderIcon('screen-share', { class: icon })}
              </media-screen-share-button>
              <media-tooltip id="screen-share-tooltip" side="top" class="${cn(popup.tooltip)}">
                <media-tooltip-label></media-tooltip-label>
                <media-tooltip-shortcut class="${popup.tooltipShortcut}"></media-tooltip-shortcut>
              </media-tooltip>
            </div>

            <div class="${spacer}" aria-hidden="true"></div>

            <div class="${buttonGroup}">
              <media-publish-button class="${cn(button.base, button.publish)}"></media-publish-button>

              <media-fullscreen-button commandfor="fullscreen-tooltip" class="${cn(button.base, button.subtle, button.icon, iconState.fullscreen.button)}">
                ${renderIcon('fullscreen-enter', { class: cn(icon, iconState.fullscreen.enter) })}
                ${renderIcon('fullscreen-exit', { class: cn(icon, iconState.fullscreen.exit) })}
              </media-fullscreen-button>
              <media-tooltip id="fullscreen-tooltip" side="top" class="${cn(popup.tooltip)}">
                <media-tooltip-label></media-tooltip-label>
                <media-tooltip-shortcut class="${popup.tooltipShortcut}"></media-tooltip-shortcut>
              </media-tooltip>
            </div>
          </media-tooltip-group>
        </media-controls-content>
      </media-controls>

      <!-- Hotkeys -->
      <media-hotkey keys="m" action="toggleMicMuted"></media-hotkey>
      <media-hotkey keys="v" action="toggleCameraMuted"></media-hotkey>
      <media-hotkey keys="f" action="toggleFullscreen"></media-hotkey>
    </media-container>
  `;
}

export class PublisherSkinTailwindElement extends SkinElement {
  static readonly tagName = 'publisher-skin-tailwind';
  static template = createTemplate(getTemplateHTML());
}

declare global {
  interface HTMLElementTagNameMap {
    [PublisherSkinTailwindElement.tagName]: PublisherSkinTailwindElement;
  }
}
