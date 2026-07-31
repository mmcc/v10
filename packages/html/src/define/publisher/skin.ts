import { cameraText, enableDevicesText, microphoneText } from '@videojs/core/i18n/text/publish';
import { renderIcon } from '@videojs/icons/render';
import { createShadowStyle, createTemplate } from '@videojs/utils/dom';
import { renderText } from '../../i18n/render-text';
import { safeDefine } from '../safe-define';
import { SkinElement } from '../skin-element';
import styles from './skin.css?inline';

// Register the video publisher, container, and all publisher UI custom elements.
import './ui';

function getTemplateHTML() {
  return /*html*/ `
    <media-container class="media-default-skin media-default-skin--publisher">
      <!-- @deprecated slot="media" is no longer required, use the default slot instead -->
      <slot name="media"></slot>
      <slot></slot>

      <media-capture-placeholder class="media-capture-placeholder">
        <div class="media-capture-placeholder__content">
          ${renderIcon('camera', { class: 'media-icon media-capture-placeholder__icon' })}
          <!-- Nested placeholder (without the root class) renders the state-driven message text. -->
          <media-capture-placeholder class="media-capture-placeholder__message"></media-capture-placeholder>
          <media-enable-devices-button class="media-button media-button--enable-devices">
            ${renderText(enableDevicesText)}
          </media-enable-devices-button>
        </div>
      </media-capture-placeholder>

      <div class="media-publish-status">
        <media-publish-badge class="media-badge media-badge--publish"></media-publish-badge>
        <media-publish-timer class="media-publish-timer"></media-publish-timer>
        <media-connection-indicator class="media-connection-indicator">
          ${renderIcon('signal', { class: 'media-icon media-icon--signal' })}
        </media-connection-indicator>
      </div>

      <media-error-dialog class="media-error">
        <div class="media-error__dialog media-surface">
          <div class="media-error__content">
            <media-alert-dialog-title class="media-error__title"></media-alert-dialog-title>
            <media-alert-dialog-description class="media-error__description"></media-alert-dialog-description>
          </div>
          <div class="media-error__actions">
            <media-alert-dialog-close class="media-button media-button--primary"></media-alert-dialog-close>
          </div>
        </div>
      </media-error-dialog>

      <media-controls class="media-surface media-controls media-controls--root">
        <media-tooltip-group>
          <div class="media-button-group">
            <media-camera-button commandfor="camera-tooltip" class="media-button media-button--subtle media-button--icon media-button--camera">
              ${renderIcon('camera', { class: 'media-icon media-icon--camera' })}
              ${renderIcon('camera-off', { class: 'media-icon media-icon--camera-off' })}
            </media-camera-button>
            <media-tooltip id="camera-tooltip" side="top" class="media-surface media-tooltip">
              <media-tooltip-label></media-tooltip-label>
              <media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut>
            </media-tooltip>

            <button commandfor="camera-menu" aria-labelledby="camera-menu-label" class="media-button media-button--subtle media-button--icon">
              ${renderIcon('chevron', { class: 'media-icon' })}
              ${renderText(cameraText, { id: 'camera-menu-label', class: 'media-sr-only' })}
            </button>
            <media-menu id="camera-menu" side="top" align="center" class="media-surface media-popover media-menu">
              <media-camera-radio-group class="media-menu__group">
                <template>
                  <media-menu-radio-item class="media-menu__item">
                    <span data-part="label"></span>
                    <media-menu-item-indicator force-mount class="media-menu__indicator">
                      ${renderIcon('check', { class: 'media-icon' })}
                    </media-menu-item-indicator>
                  </media-menu-radio-item>
                </template>
              </media-camera-radio-group>
            </media-menu>

            <media-mic-button commandfor="mic-tooltip" class="media-button media-button--subtle media-button--icon media-button--mic">
              ${renderIcon('mic', { class: 'media-icon media-icon--mic' })}
              ${renderIcon('mic-off', { class: 'media-icon media-icon--mic-off' })}
            </media-mic-button>
            <media-tooltip id="mic-tooltip" side="top" class="media-surface media-tooltip">
              <media-tooltip-label></media-tooltip-label>
              <media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut>
            </media-tooltip>

            <button commandfor="mic-menu" aria-labelledby="mic-menu-label" class="media-button media-button--subtle media-button--icon">
              ${renderIcon('chevron', { class: 'media-icon' })}
              ${renderText(microphoneText, { id: 'mic-menu-label', class: 'media-sr-only' })}
            </button>
            <media-menu id="mic-menu" side="top" align="center" class="media-surface media-popover media-menu">
              <media-mic-radio-group class="media-menu__group">
                <template>
                  <media-menu-radio-item class="media-menu__item">
                    <span data-part="label"></span>
                    <media-menu-item-indicator force-mount class="media-menu__indicator">
                      ${renderIcon('check', { class: 'media-icon' })}
                    </media-menu-item-indicator>
                  </media-menu-radio-item>
                </template>
              </media-mic-radio-group>
            </media-menu>

            <media-screen-share-button commandfor="screen-share-tooltip" class="media-button media-button--subtle media-button--icon media-button--screen-share">
              ${renderIcon('screen-share', { class: 'media-icon media-icon--screen-share' })}
            </media-screen-share-button>
            <media-tooltip id="screen-share-tooltip" side="top" class="media-surface media-tooltip">
              <media-tooltip-label></media-tooltip-label>
              <media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut>
            </media-tooltip>
          </div>

          <div class="media-controls__spacer" aria-hidden="true"></div>

          <div class="media-button-group">
            <media-publish-button class="media-button media-button--publish"></media-publish-button>

            <media-fullscreen-button commandfor="fullscreen-tooltip" class="media-button media-button--subtle media-button--icon media-button--fullscreen">
              ${renderIcon('fullscreen-enter', { class: 'media-icon media-icon--fullscreen-enter' })}
              ${renderIcon('fullscreen-exit', { class: 'media-icon media-icon--fullscreen-exit' })}
            </media-fullscreen-button>
            <media-tooltip id="fullscreen-tooltip" side="top" class="media-surface media-tooltip">
              <media-tooltip-label></media-tooltip-label>
              <media-tooltip-shortcut class="media-tooltip__kbd"></media-tooltip-shortcut>
            </media-tooltip>
          </div>
        </media-tooltip-group>
      </media-controls>

      <div class="media-overlay"></div>

      <!-- Hotkeys -->
      <media-hotkey keys="m" action="toggleMicMuted"></media-hotkey>
      <media-hotkey keys="v" action="toggleCameraMuted"></media-hotkey>
      <media-hotkey keys="f" action="toggleFullscreen"></media-hotkey>
    </media-container>
  `;
}

export class PublisherSkinElement extends SkinElement {
  static readonly tagName = 'publisher-skin';
  static styles = createShadowStyle(styles);
  static template = createTemplate(getTemplateHTML());
}

safeDefine(PublisherSkinElement);

declare global {
  interface HTMLElementTagNameMap {
    [PublisherSkinElement.tagName]: PublisherSkinElement;
  }
}
