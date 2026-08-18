import { PublishButtonCore, PublishButtonDataAttrs, type PublishButtonMediaState } from '@videojs/core';
import {
  applyElementProps,
  applyStateDataAttrs,
  createButton,
  logMissingFeature,
  selectCaptureSource,
  selectPublish,
} from '@videojs/core/dom';
import { resolveText, type Text, translateText } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';
import type { State } from '@videojs/store';

import { i18nContext } from '../../i18n/context';
import { I18nController } from '../../i18n/controller';
import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaElement } from '../media-element';

/**
 * `<media-publish-button>` — selects from the `publish` and `captureSource`
 * features and composes them into the `PublishButtonMediaState` consumed by
 * `PublishButtonCore`.
 *
 * Doesn't extend `MediaButtonElement` because that base couples a button to
 * a single feature selector; the PublishButton needs two.
 */
export class PublishButtonElement extends MediaElement {
  static readonly tagName = 'media-publish-button';

  static override properties: PropertyDeclarationMap = {
    label: { type: String },
    disabled: { type: Boolean },
  };

  disabled = false;
  label: Text | string = '';

  protected readonly core = new PublishButtonCore();

  protected readonly publish = new PlayerController(this, playerContext, selectPublish);
  protected readonly captureSource = new PlayerController(this, playerContext, selectCaptureSource);
  readonly #i18n = new I18nController(this, i18nContext);

  get $state(): State<PublishButtonCore.State> {
    return this.core.state;
  }

  #defaultContent = false;
  #disconnect: AbortController | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    this.#defaultContent ||= !this.textContent?.trim();
    if (this.#defaultContent) {
      this.textContent = translateText(this.core.getLabel(this.core.state.current), this.#i18n.value);
    }

    this.#disconnect = new AbortController();

    const buttonProps = createButton({
      onActivate: () => {
        const media = this.#getMedia();
        // Fire-and-forget: failures surface through the `publish` feature state.
        if (media) void this.core.toggle(media);
      },
      isDisabled: () => this.disabled || !this.#getMedia(),
    });

    applyElementProps(this, buttonProps, { signal: this.#disconnect.signal });

    if (__DEV__ && !this.#getMedia()) {
      logMissingFeature(this.localName, this.publish.displayName ?? 'publish');
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#disconnect?.abort();
    this.#disconnect = null;
  }

  /** Returns the button's current label derived from media state. */
  getLabel(): string | undefined {
    return this.core.state.current.label ? resolveText(this.core.state.current.label) : undefined;
  }

  /** Resolved label for tooltips and other display surfaces. */
  getResolvedLabel(): string | undefined {
    const media = this.#getMedia();
    if (!media) return undefined;
    const state = this.core.getState();
    return translateText(this.core.getLabel(state), this.#i18n.value);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    this.core.setProps(this);
  }

  protected override update(changed: PropertyValues): void {
    super.update(changed);

    const media = this.#getMedia();
    if (media) this.core.setMedia(media);
    const state = media ? this.core.getState() : this.core.state.current;

    if (this.#defaultContent) {
      // The default label follows the session ("Go live" ↔ "Stop stream").
      this.textContent = translateText(this.core.getLabel(state), this.#i18n.value);
    }

    if (!media) return;

    const attrs = this.core.getAttrs(state);
    applyElementProps(this, {
      ...attrs,
      'aria-label': translateText(attrs['aria-label'], this.#i18n.value),
    });
    applyStateDataAttrs(this, state, PublishButtonDataAttrs);
  }

  /**
   * Compose the PublishButton media state from the two feature slices.
   * Returns `null` when either is missing so the button stays disabled until
   * both features are registered on the player.
   */
  #getMedia(): PublishButtonMediaState | null {
    const publish = this.publish.value;
    const captureSource = this.captureSource.value;
    if (!publish || !captureSource) return null;
    return {
      publishState: publish.publishState,
      publishStartedAt: publish.publishStartedAt,
      publishError: publish.publishError,
      publish: publish.publish,
      unpublish: publish.unpublish,
      cameraState: captureSource.cameraState,
      screenShareState: captureSource.screenShareState,
      micState: captureSource.micState,
      micActive: captureSource.micActive,
    };
  }
}
