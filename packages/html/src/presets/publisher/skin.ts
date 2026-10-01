import { createShadowStyle } from '@videojs/utils/dom';

import { template } from '../../internal/skins/default-publisher/template';
import { SkinElement } from '../skin';

import styles from '../../define/publisher/skin.css?inline';

/** Packaged MoQ publisher UI registered as `<publisher-skin>`. */
export class PublisherSkinElement extends SkinElement {
  static readonly tagName = 'publisher-skin';
  static styles = createShadowStyle(styles);
  static template = template;
}

declare global {
  interface HTMLElementTagNameMap {
    [PublisherSkinElement.tagName]: PublisherSkinElement;
  }
}
