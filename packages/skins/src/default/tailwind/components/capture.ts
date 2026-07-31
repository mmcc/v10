import { cn } from '@videojs/utils/style';

/**
 * Capture placeholder — covers the media area (like poster/overlay) until a
 * local capture stream is active. Visible for idle/acquiring/denied/ended.
 */
export const capturePlaceholder = {
  root: cn(
    'group/capture absolute inset-0 z-5 grid place-content-center',
    'rounded-[inherit] text-center text-white',
    'bg-(--media-capture-placeholder-background,oklch(0.2_0_0))',
    'data-[capture-state=active]:hidden'
  ),
  content: cn(
    'flex max-w-80 flex-col items-center gap-3 p-4',
    'group-data-[capture-state=acquiring]/capture:opacity-70'
  ),
  icon: 'size-[calc(var(--media-icon-size)*2)] opacity-50',
  message: cn(
    'text-(length:--font-size-medium) opacity-70 wrap-anywhere',
    // While idle/ended the message would repeat the enable-devices CTA text —
    // let the CTA carry it and only show acquiring/denied guidance here.
    'data-[capture-state=idle]:hidden data-[capture-state=ended]:hidden',
    'group-data-[capture-state=denied]/capture:text-(--media-publish-live-color)',
    'group-data-[capture-state=denied]/capture:opacity-100'
  ),
};

/** Enable devices CTA — primary treatment; pairs with `button.base`. */
export const enableDevicesButton = cn(
  'bg-white font-medium text-black text-shadow-none',
  'data-[capture-state=acquiring]:cursor-progress data-[capture-state=acquiring]:opacity-70',
  'data-[capture-state=acquiring]:active:scale-100'
);

/**
 * Screen share toggle — active affordance while sharing (mirrors the
 * `aria-expanded` treatment on subtle buttons, slightly stronger). Pairs with
 * `button.base` + `button.subtle` + `button.icon`.
 */
export const screenShareButton = 'data-sharing:bg-current/15';

/**
 * Camera/mic icon state (mirrors `shared/tailwind/icon-state.ts`). The muted
 * (slashed) icon is tinted with the publisher live color as a warning.
 */
export const captureIconState = {
  camera: {
    button: 'group',
    on: 'hidden opacity-0 group-not-data-muted:block group-not-data-muted:opacity-100',
    off: cn(
      'hidden opacity-0 group-data-muted:block group-data-muted:opacity-100',
      'group-data-muted:text-(--media-publish-live-color)'
    ),
  },
  mic: {
    button: 'group',
    on: 'hidden opacity-0 group-not-data-muted:block group-not-data-muted:opacity-100',
    off: cn(
      'hidden opacity-0 group-data-muted:block group-data-muted:opacity-100',
      'group-data-muted:text-(--media-publish-live-color)'
    ),
  },
};
