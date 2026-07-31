'use client';

import { MoqPublishMedia } from '@videojs/media/dom/moq-publish';
import type { MoqPublishMediaProps } from '@videojs/spf/moq-publish';
import { moqPublishMediaDefaultProps } from '@videojs/spf/moq-publish';
import type { ReactNode, VideoHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { useAttachMedia } from '../../utils/use-attach-media';
import { useComposedRefs } from '../../utils/use-composed-refs';
import { useMediaInstance } from '../../utils/use-media-instance';
import { useSyncProps } from '../../utils/use-sync-props';

export interface MoqPublishVideoProps
  extends Omit<VideoHTMLAttributes<HTMLVideoElement>, keyof MoqPublishMediaProps>,
    Partial<MoqPublishMediaProps> {
  children?: ReactNode;
}

/**
 * Publisher media component backed by the SPF MoQ publish engine. The
 * rendered `<video>` element is the local capture preview (muted, inline,
 * autoplaying); the publisher props (`publishEndpoint`, `publishNamespace`,
 * `captureSource`, device selections, and mute toggles) are forwarded to the
 * underlying `MoqPublishMedia` host.
 */
export const MoqPublishVideo = forwardRef<HTMLVideoElement, MoqPublishVideoProps>(function MoqPublishVideo(
  { children, ...props },
  ref
) {
  const media = useMediaInstance(MoqPublishMedia);
  const attachRef = useAttachMedia(media);
  const composedRef = useComposedRefs(attachRef, ref);
  const htmlProps = useSyncProps(media, props, moqPublishMediaDefaultProps);

  return (
    <video muted playsInline autoPlay ref={composedRef} {...htmlProps}>
      {children}
    </video>
  );
});

export namespace MoqPublishVideo {
  export type Props = MoqPublishVideoProps;
}
