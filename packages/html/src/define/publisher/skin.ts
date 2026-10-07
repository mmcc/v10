import { VideoPublisherElement } from '../../presets/publisher/player';
import { PublisherSkinElement } from '../../presets/publisher/skin';
import { safeDefine } from '../../registration/safe-define';
import '../../internal/skins/default-publisher/register';

// The skin entry has always registered its player too, so `<video-publisher>` works with this one import.
safeDefine(VideoPublisherElement);
safeDefine(PublisherSkinElement);
