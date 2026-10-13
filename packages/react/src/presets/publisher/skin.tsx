'use client';

import { PublisherSkin as Skin } from '../../internal/skins/default-publisher/skin';
import type { BaseSkinProps } from '../types';

export interface PublisherSkinProps extends BaseSkinProps {}

export function PublisherSkin(props: PublisherSkinProps) {
  return <Skin {...props} />;
}
