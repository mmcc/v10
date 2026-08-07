import { PublishTimerCore, PublishTimerDataAttrs } from '@videojs/core';
import { selectPublish } from '@videojs/core/dom';
import type { Text } from '@videojs/core/i18n';
import type { PropertyDeclarationMap, PropertyValues } from '@videojs/element';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/player-controller';
import { MediaUIElement } from '../media-ui-element';

/**
 * `<media-publish-timer>` — elapsed time since the publish session went
 * live. `PublishTimerCore` is tick-less: this element owns a one-second
 * interval that runs only while the session is `live`, passing a fresh
 * `now` to the core on every render.
 */
export class PublishTimerElement extends MediaUIElement<PublishTimerCore> {
  static readonly tagName = 'media-publish-timer';

  static override properties: PropertyDeclarationMap = {
    label: { type: String },
  };

  label: Text | string = '';

  protected readonly core = new PublishTimerCore();
  protected readonly stateAttrMap = PublishTimerDataAttrs;
  protected readonly mediaState = new PlayerController(this, playerContext, selectPublish);

  readonly #textNode = document.createTextNode('');
  #interval: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.destroyed) return;

    if (!this.#textNode.parentNode) this.appendChild(this.#textNode);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#stopInterval();
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    this.core.setProps({ label: this.label, now: Date.now() });
  }

  protected override update(changed: PropertyValues): void {
    // The base update refreshes core state from media and applies attrs.
    super.update(changed);

    const state = this.core.state.current;
    this.#textNode.textContent = state.elapsedText;
    // Guard on the media slice: without it the base update skipped
    // `getState()`, so `session` could be stale from a detached store.
    this.#syncInterval(!!this.mediaState.value && state.session === 'live');
  }

  #syncInterval(live: boolean): void {
    if (!live) {
      this.#stopInterval();
      return;
    }
    // Each tick re-renders, which feeds a fresh `now` through `willUpdate`.
    this.#interval ??= setInterval(() => this.requestUpdate(), 1000);
  }

  #stopInterval(): void {
    if (this.#interval === null) return;
    clearInterval(this.#interval);
    this.#interval = null;
  }
}
