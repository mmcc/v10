import { HTMLVideoAdapter } from '@videojs/media/dom';

import { MoqPublishMediaMixin } from '../../engines/moq/adapter';

const MoqPublishMediaBase = MoqPublishMediaMixin(HTMLVideoAdapter);

/**
 * Publisher media host backed by the SPF MoQ publish engine. The attached `<video>` element is the local capture
 * preview; the publisher capability surface (capture source/devices/toggles, publish session, stats) comes from the
 * engine adapter mixin.
 */
export class MoqPublishMedia extends MoqPublishMediaBase {}
