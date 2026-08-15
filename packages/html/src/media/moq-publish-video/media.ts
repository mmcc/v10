import { CustomMediaElement } from '@videojs/media/dom/custom-media-element';
import { MoqPublishMedia } from '@videojs/spf/moq-publish';
import { MediaAttachMixin } from '../../store/media-attach-mixin';

const MoqPublishVideoBase = MediaAttachMixin(CustomMediaElement('video', MoqPublishMedia));

/**
 * Reflects the engine's involuntary intent-consumption (denied, failed,
 * out-of-band ended — see acquire-capture-source's multi-writer contract)
 * back onto `camera-active`/`screen-share-active`. The element property
 * setter routes through `toggleAttribute`, so a stale attribute would
 * swallow the next `cameraActive = true` write (no attribute mutation →
 * no attributeChangedCallback → no retry). Writing the host's own value
 * back dedupes at the signal layer, so this cannot loop.
 *
 * Shared rather than inlined per element: any element built the same way
 * around a `MoqPublishMedia`-shaped host (this one, or a seamed twin like
 * the sandbox's loopback publisher) needs the identical reconciliation —
 * one behavioral contract, not a copy that can drift per element.
 */
export function installCaptureAttributeReflection(
  el: HTMLElement & { host: Pick<MoqPublishMedia, 'cameraActive' | 'screenShareActive'> }
): void {
  el.addEventListener('capturesourcechange', () => {
    el.toggleAttribute('camera-active', el.host.cameraActive);
    el.toggleAttribute('screen-share-active', el.host.screenShareActive);
  });
}

/**
 * Publisher media element — the shadow `<video>` is the local capture
 * preview and the host is `MoqPublishMedia` (capture + MoQ publish session).
 *
 * The publisher-specific host props are declared in `properties` so
 * `CustomMediaElement` maps their kebab-case attributes onto the host
 * accessors (`publish-endpoint` → `publishEndpoint`, …) instead of
 * mirroring them onto the preview `<video>`. `camera-active` /
 * `screen-share-active` are additive booleans, not an exclusive selection —
 * removing either attribute releases only that source.
 */
export class MoqPublishVideo extends MoqPublishVideoBase {
  static properties = {
    ...MoqPublishVideoBase.properties,
    publishEndpoint: { type: String, attribute: 'publish-endpoint', empty: '' },
    publishNamespace: { type: String, attribute: 'publish-namespace', empty: '' },
    publishAuthToken: { type: String, attribute: 'publish-auth-token', empty: '' },
    cameraActive: { type: Boolean, attribute: 'camera-active' },
    screenShareActive: { type: Boolean, attribute: 'screen-share-active' },
  };

  constructor() {
    super();
    installCaptureAttributeReflection(this);
  }
}
