import { cn } from '@videojs/utils/style';

/**
 * Publisher elements signal disabled via `data-disabled` (custom elements
 * can't rely on the native `disabled` attribute); mirrors the `disabled:`
 * treatment in `button.base`.
 */
export const buttonDataDisabled = cn(
  'data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:grayscale'
);

/**
 * Publish button — the primary call to action. White pill by default
 * ("Go live"), solid red while live ("Stop"). Pairs with `button.base`.
 */
export const publishButton = cn(
  // Reserve room so the label swap (Go live ↔ Stop) doesn't resize the bar.
  'min-w-20 bg-white font-medium text-black text-shadow-none',
  'transition-[background-color,color,opacity,outline-offset,scale]',
  'data-[publish-state=live]:bg-(--media-publish-live-color) data-[publish-state=live]:text-white',
  // Transitional states: subdued and non-interactive cursor.
  'data-[publish-state=connecting]:cursor-progress data-[publish-state=connecting]:opacity-70',
  'data-[publish-state=connecting]:active:scale-100',
  'data-[publish-state=stopping]:cursor-progress data-[publish-state=stopping]:opacity-70',
  'data-[publish-state=stopping]:active:scale-100',
  // Error: translucent red so it reads as attention without mimicking live.
  'data-[publish-state=error]:bg-[oklch(from_var(--media-publish-live-color)_l_c_h/0.15)]',
  'data-[publish-state=error]:text-(--media-publish-live-color)'
);

/**
 * Status row — overlay capsule for badge + timer + connection indicator.
 * Positioned top-left, mirroring the controls inset.
 *
 * The row carries its own ground rather than relying on text shadows: it sits
 * over an arbitrary camera frame, and a bright one leaves bare white text (the
 * timer especially) unreadable. It borrows the surface border/shadow tokens
 * but takes a dark fill instead of the glass one — glass tracks the frame
 * behind it, which is what fails over bright video.
 */
export const publishStatus = cn(
  'pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-2',
  '@2xl/media-root:top-3 @2xl/media-root:left-3',
  'rounded-full px-3 py-1.5',
  'bg-(--media-publish-status-background) [backdrop-filter:var(--media-surface-backdrop-filter)]',
  'shadow-[0_0_0_1px_var(--media-surface-outer-border-color),0_1px_3px_0_var(--media-surface-shadow-color),inset_0_1px_0_0_var(--media-surface-inner-border-color)]',
  '[color:var(--media-color-primary,oklch(1_0_0))]'
);

/**
 * Publish badge — status text with a leading dot (mirrors the live button's
 * dot in `button.live`). The status capsule is already its ground, so the
 * badge drops the `badge` fill and only takes a pill back when a state needs
 * to stand on its own: solid red live, tinted red error. Pairs with `badge`.
 */
export const publishBadge = cn(
  // `p-0!` / `px-2!` beat the shared `badge` padding, which `cn` concatenates
  // rather than merges; the state variants then out-specify the reset.
  'inline-flex items-center gap-1.5 p-0! font-semibold uppercase tracking-wider',
  'bg-transparent',
  'before:inline-block before:size-2 before:shrink-0 before:rounded-full',
  'before:bg-current/40 before:transition-colors before:duration-150 before:ease-out',
  'data-[publish-state=live]:px-2! data-[publish-state=live]:py-1!',
  'data-[publish-state=error]:px-2! data-[publish-state=error]:py-1!',
  'data-[publish-state=live]:bg-(--media-publish-live-color) data-[publish-state=live]:text-white',
  'data-[publish-state=live]:before:bg-white',
  'data-[publish-state=error]:bg-[oklch(from_var(--media-publish-live-color)_l_c_h/0.15)]',
  'data-[publish-state=error]:text-(--media-publish-live-color)',
  'motion-safe:data-[publish-state=live]:before:animate-media-pulse',
  'motion-safe:data-[publish-state=connecting]:before:animate-media-pulse'
);

/** Publish timer — elapsed publish time. Only meaningful while live/stopping. */
export const publishTimer = cn(
  'hidden whitespace-nowrap text-(length:--font-size-small) tabular-nums',
  'data-[publish-state=live]:inline-block data-[publish-state=stopping]:inline-block'
);

/** Connection indicator — hosts the `signal` icon, tinted by quality. */
export const connectionIndicator = cn(
  'inline-flex items-center transition-[color,opacity] duration-150 ease-out',
  'data-[quality=unknown]:opacity-50',
  'data-[quality=good]:text-(--media-quality-good-color)',
  'data-[quality=fair]:text-(--media-quality-fair-color)',
  'data-[quality=poor]:text-(--media-quality-poor-color)'
);
