import { CustomMediaElement } from '@videojs/media/dom/custom-media-element';
import { MoqPublishMedia } from '@videojs/media/dom/moq-publish';
import { MediaAttachMixin } from '../../store/media-attach-mixin';

const MoqPublishVideoBase = MediaAttachMixin(CustomMediaElement('video', MoqPublishMedia));

/**
 * Publisher media element — the shadow `<video>` is the local capture
 * preview and the host is `MoqPublishMedia` (capture + MoQ publish session).
 *
 * The publisher-specific host props are declared in `properties` so
 * `CustomMediaElement` maps their kebab-case attributes onto the host
 * accessors (`publish-endpoint` → `publishEndpoint`, …) instead of
 * mirroring them onto the preview `<video>`. `capture-source` uses
 * `empty: null` so removing the attribute releases capture.
 */
export class MoqPublishVideo extends MoqPublishVideoBase {
  static properties = {
    ...MoqPublishVideoBase.properties,
    publishEndpoint: { type: String, attribute: 'publish-endpoint', empty: '' },
    publishNamespace: { type: String, attribute: 'publish-namespace', empty: '' },
    captureSource: { type: String, attribute: 'capture-source', empty: null },
  };
}
