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
 * Device split control (mirrors `components/capture.css`) — pairs a capture
 * toggle with the caret that opens its device picker so the picker reads as an
 * affordance on the toggle rather than a peer control in the bar.
 */
export const deviceControl = {
  /**
   * Wrapper holding the toggle, its tooltip, the caret, and the picker menu.
   * It carries the hover/focus pill spanning both segments; each segment keeps
   * its own subtle background, which stacks on top so the hovered hit target
   * stays legible.
   */
  root: cn(
    'flex items-center rounded-full',
    'transition-colors duration-150 ease-out',
    'hover:bg-current/10 focus-within:bg-current/10'
  ),
  /**
   * Group of split controls — segments sit flush inside a control, so the group
   * needs more room than the shared 1px between its members.
   */
  group: 'gap-2',
  /**
   * Caret segment — narrower and dimmer than the toggle, but never below the
   * 24px minimum target size. Pairs with `button.base` + `button.subtle`, but
   * *not* `button.icon`, which forces a square. The `has-` rules mirror the
   * stylesheet's availability hide for the HTML twin; the React skin omits the
   * caret outright instead.
   */
  caret: cn(
    'group/caret relative grid w-6 p-0!',
    'before:absolute before:inset-y-[30%] before:start-0 before:w-px before:bg-current/25',
    '[&:has(+media-menu_media-camera-radio-group[data-availability=unavailable])]:hidden',
    '[&:has(+media-menu_media-mic-radio-group[data-availability=unavailable])]:hidden'
  ),
  /** Chevron inside the caret — the asset points right, so aim it at the menu above. */
  caretIcon: cn(
    'size-3.5 -rotate-90 opacity-65 drop-shadow-[0_1px_0_var(--media-current-shadow-color)]',
    'transition-[rotate,opacity] duration-150 ease-out motion-reduce:duration-0',
    'group-hover/caret:opacity-100 group-focus-visible/caret:opacity-100 group-aria-expanded/caret:opacity-100',
    // Point back at the toggle while the picker is open.
    'group-aria-expanded/caret:rotate-90'
  ),
};

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
