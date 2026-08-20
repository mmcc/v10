import { cn } from '@videojs/utils/style';
import { iconState as baseIconState } from '../../shared/tailwind/icon-state';
import { badge as baseBadge } from './components/badge';
import { button as baseButton } from './components/button';
import { buttonGroup as baseButtonGroup } from './components/button-group';
import {
  deviceControl as baseDeviceControl,
  captureIconState,
  enableDevicesButton,
  screenShareButton,
} from './components/capture';
import { container as baseRoot } from './components/container';
import { controls as baseControls } from './components/controls';
import { error as baseError } from './components/error';
import { menu as baseMenu } from './components/menu';
import { overlay as baseOverlay } from './components/overlay';
import { popup as basePopup } from './components/popup';
import { publishBadge as basePublishBadge, buttonDataDisabled, publishButton } from './components/publish';
import { surface } from './components/surface';

/* ==========================================================================
   Root
   ========================================================================== */

export const root = (isShadowDOM: boolean) =>
  cn(
    baseRoot,
    'group/skin',
    'bg-black overflow-clip',
    // Inner border ring
    'after:absolute after:pointer-events-none after:rounded-[inherit] after:z-10',
    '[&:fullscreen]:after:hidden',
    'after:inset-0 after:ring-1 after:ring-inset after:ring-(color:--border-color)',
    // Preview video element. The horizontal mirror matches self-view
    // expectations; unconditional in v1 (also flips screen-share previews) —
    // see components/capture.css for rationale. Only the local preview is
    // mirrored, the published stream is untouched.
    {
      '[&_::slotted(video)]:block [&_::slotted(video)]:w-full [&_::slotted(video)]:h-full [&_::slotted(video)]:rounded-(--media-video-border-radius) [&_::slotted(video)]:[object-fit:var(--media-object-fit,contain)] [&_::slotted(video)]:[object-position:var(--media-object-position,center)] [&_::slotted(video)]:[scale:-1_1]':
        isShadowDOM,
      '[&_video]:block [&_video]:w-full [&_video]:h-full [&_video]:rounded-[inherit] [&_video]:[object-fit:var(--media-object-fit,contain)] [&_video]:[object-position:var(--media-object-position,center)] [&_video]:[scale:-1_1]':
        !isShadowDOM,
    },
    '[--default-accent-color:oklch(1_0_0)]',
    '[--border-color:light-dark(oklch(0_0_0/0.1),oklch(1_0_0/0.15))]',
    '[--focus-ring-color:light-dark(oklch(0_0_0),oklch(1_0_0))]',
    '[--media-video-border-radius:var(--container-border-radius)]',
    '[--controls-transition-duration:100ms]',
    '[--controls-transition-timing-function:ease-out]',
    '[--error-dialog-transition-duration:350ms]',
    '[--error-dialog-transition-delay:100ms]',
    '[--error-dialog-transition-timing-function:ease-out]',
    '[--popup-transition-duration:100ms]',
    '[--popup-transition-timing-function:ease-out]',
    '[--surface-background-color:oklch(1_0_0/0.1)]',
    '[--surface-inner-border-color:oklch(1_0_0/0.1)]',
    '[--surface-outer-border-color:oklch(0_0_0/0.1)]',
    '[--surface-shadow-color:oklch(0_0_0/0.15)]',
    '[--surface-backdrop-filter:blur(16px)_saturate(1.5)]',
    // Publisher tokens. The live color matches the live-edge dot in
    // `button.live` (no shared red token exists yet); quality colors are
    // literals chosen to hold up on dark video — visual QA welcome.
    '[--publish-live-color:oklch(0.65_0.22_27)]',
    '[--quality-good-color:oklch(0.72_0.19_149)]',
    '[--quality-fair-color:oklch(0.8_0.16_85)]',
    '[--quality-poor-color:var(--publish-live-color)]',
    // Ground for the top-left status capsule. Deliberately dark rather than
    // the glass surface fill: it overlays live camera frames, and a
    // translucent ground inherits whatever brightness is behind it.
    '[--publish-status-background:oklch(0_0_0/0.6)]',
    // Fullscreen scale
    'min-[1280px]:[&:fullscreen]:[--scale:1.25]',
    'min-[1536px]:[&:fullscreen]:[--scale:1.5]',
    'min-[1920px]:[&:fullscreen]:[--scale:1.75]',
    'motion-reduce:[--error-dialog-transition-duration:50ms]',
    'motion-reduce:[--error-dialog-transition-delay:0ms]',
    'motion-reduce:[--popup-transition-duration:0ms]',
    '[@media(prefers-reduced-transparency:reduce)]:[--surface-background-color:oklch(0_0_0)]',
    'contrast-more:[--surface-background-color:oklch(0_0_0)]',
    '[@media(prefers-reduced-transparency:reduce)]:[--surface-inner-border-color:oklch(1_0_0/0.25)]',
    'contrast-more:[--surface-inner-border-color:oklch(1_0_0/0.25)]',
    '[@media(prefers-reduced-transparency:reduce)]:[--surface-outer-border-color:transparent]',
    'contrast-more:[--surface-outer-border-color:transparent]',
    '[@media(prefers-reduced-transparency:reduce)]:[--publish-status-background:oklch(0_0_0)]',
    'contrast-more:[--publish-status-background:oklch(0_0_0)]',
    // Fullscreen
    '[&:fullscreen]:[--container-border-radius:0]',
    {
      '[&:fullscreen_video]:object-contain': !isShadowDOM,
      '[&:fullscreen_::slotted(video)]:object-contain': isShadowDOM,
    }
  );

/* ==========================================================================
   Controls
   Publishers must always see mute/stop controls, so the bar never hides
   (no `data-visible` show/hide behavior in v1).
   ========================================================================== */

export const controls = cn(
  baseControls,
  surface,
  'group/controls',
  'text-white z-10',
  'peer-data-open/error:hidden!',
  'absolute bottom-2 inset-x-2',
  '@2xl/media-root:bottom-3 @2xl/media-root:inset-x-3',
  '@2xl/media-root:[--base-boundary-offset:3]'
);

/* ==========================================================================
   Button groups
   ========================================================================== */

export const buttonGroup = baseButtonGroup;

export const spacer = 'grow';

/* ==========================================================================
   Device split controls (capture toggle + its device picker)
   ========================================================================== */

export const deviceControl = baseDeviceControl;

/** Button group holding the split controls — wider gaps than the shared 1px. */
export const deviceGroup = cn(baseButtonGroup, baseDeviceControl.group);

/* ==========================================================================
   Buttons
   ========================================================================== */

export const button = {
  ...baseButton,
  base: cn(baseButton.base, buttonDataDisabled),
  publish: publishButton,
  enableDevices: enableDevicesButton,
  screenShare: screenShareButton,
};

/* ==========================================================================
   Status row (badge + timer + connection indicator)
   ========================================================================== */

export const badge = baseBadge;

export const publishBadge = cn(baseBadge, basePublishBadge);

export { connectionIndicator, publishStatus, publishTimer } from './components/publish';

/* ==========================================================================
   Overlay (always-visible scrim — the controls never hide)
   ========================================================================== */

export const overlay = cn(baseOverlay, 'opacity-100');

/* ==========================================================================
   Popup (with video surface)
   ========================================================================== */

export const popup = {
  ...basePopup,
  popover: cn(surface, basePopup.popover),
  tooltip: cn(surface, basePopup.tooltip),
};

/* ==========================================================================
   Menu (device pickers reuse the menu vocabulary)
   ========================================================================== */

export const menu = baseMenu;

/* ==========================================================================
   Error (with video surface)
   ========================================================================== */

export const error = {
  ...baseError,
  dialog: cn(baseError.dialog, surface, 'w-full text-shadow-2xs text-shadow-black/25'),
  content: cn(baseError.content, 'text-shadow-inherit'),
  title: cn(baseError.title, 'text-(length:--font-size-medium)'),
};

/* ==========================================================================
   Icon state (playback states + camera/mic muted swaps)
   ========================================================================== */

export const iconState = {
  ...baseIconState,
  ...captureIconState,
};

/* ==========================================================================
   Shared components (no overrides)
   ========================================================================== */

export { capturePlaceholder } from './components/capture';
export { icon, iconContainer, iconFlipped, iconHidden } from './components/icon';
