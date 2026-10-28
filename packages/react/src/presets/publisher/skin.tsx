'use client';

import { PublisherSkin as Skin } from '../../internal/skins/default-publisher/skin';
import type { BaseSkinProps } from '../types';

/** @internal */
export interface PublisherSkinProps extends BaseSkinProps {}

/** @internal */
export function PublisherSkin(props: PublisherSkinProps) {
  return <Skin {...props} />;
}
