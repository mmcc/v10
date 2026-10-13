import { styles } from 'vjsc/styles';

/**
 * Primary call-to-action fill: white pill with dark text, as on the enable-devices and Go live buttons. The colors are
 * important because Tailwind output does not order them after the shared button's `text-inherit`.
 */
const primaryPill = [
  'w-auto min-w-20 px-3 rounded-media-pill font-medium',
  'bg-white! text-black! [text-shadow:none] not-aria-disabled:hover:bg-white/90!',
] as const;

export default styles({
  file: 'publisher.css',
  prefix: 'media-publisher',
  rules: {
    root: {
      // The skin root shares the container's scope root, so its rules must also match `:scope`.
      scopeRoot: true,
      // Mirror the local preview so movement matches a mirror. The published stream is untouched.
      utilities: 'bg-black [&_video]:[scale:-1_1]',
      variants: {
        'shadow-dom': '[&>slot::slotted(video)]:[scale:-1_1]',
      },
    },
    controls: {
      // Publishers must always reach mute and stop, so the bar and its scrim never hide.
      backdrop: {
        utilities: 'pointer-events-none absolute inset-0 z-10 rounded-[inherit] bg-(image:--media-controls-gradient)',
      },
      content: {
        utilities: [
          'absolute inset-x-2 bottom-2 z-30 flex items-center gap-2 rtl:flex-row-reverse rounded-media-controls p-1',
          'bg-media-popover text-media-popover-foreground surface-media after:surface-media-inset text-shadow-media',
          'media-2xl:inset-x-3 media-2xl:bottom-3',
        ],
      },
      group: {
        utilities: 'flex items-center gap-px rtl:flex-row-reverse',
      },
      devices: {
        // Split controls sit flush, so proximity alone has to show which segments pair.
        utilities: 'gap-2',
      },
      spacer: {
        utilities: 'flex-1',
      },
    },
    capture: {
      // Camera and mic toggles share one icon swap: the slashed icon, tinted live red, shows while muted.
      root: {
        utilities: 'group/capture',
      },
      onIcon: {
        utilities: 'group-data-muted/capture:hidden',
      },
      offIcon: {
        utilities: 'hidden text-media-live group-data-muted/capture:block',
      },
    },
    screenShare: {
      utilities: ['data-sharing:bg-current/15', 'data-[availability=unsupported]:hidden'],
    },
    device: {
      // A capture toggle fused with the caret that opens its device picker, so the caret reads as part of the toggle.
      root: {
        utilities: [
          'flex items-center rounded-media-pill transition-[background-color] duration-media-fast ease-out',
          'hover:bg-current/10 focus-within:bg-current/10',
        ],
      },
      caret: {
        utilities: [
          'group/caret relative w-6',
          // Hairline seam marking the split.
          'before:absolute before:inset-y-[30%] before:start-0 before:w-px before:bg-current/25',
          // Without a device choice to make, the caret and its menu go away and the pill hugs the toggle.
          'data-[availability=unavailable]:hidden data-[availability=unsupported]:hidden',
        ],
      },
      caretLabel: {
        utilities: 'sr-only',
      },
      caretIcon: {
        utilities: [
          'size-3.5 opacity-65 drop-shadow-media-icon transition-[opacity,rotate] duration-media-fast ease-out',
          // The chevron points right; aim it at the menu above, and back at the toggle while the menu is open.
          '-rotate-90 group-aria-expanded/caret:rotate-90',
          'group-hover/caret:opacity-100 group-focus-visible/caret:opacity-100 group-aria-expanded/caret:opacity-100',
          'motion-reduce:transition-none',
        ],
      },
    },
    publishButton: {
      utilities: [
        ...primaryPill,
        // A failed attempt keeps the Go live look, so retrying reads as the same action.
        'data-[publish-state=live]:bg-media-live! data-[publish-state=live]:text-white!',
        'data-[publish-state=live]:not-aria-disabled:hover:bg-media-live/90!',
        // Transitional states read as busy: dimmed, a progress cursor, and no press feedback.
        'data-[publish-state=connecting]:cursor-progress data-[publish-state=connecting]:opacity-70',
        'data-[publish-state=connecting]:active:scale-100',
        'data-[publish-state=stopping]:cursor-progress data-[publish-state=stopping]:opacity-70',
        'data-[publish-state=stopping]:active:scale-100',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:grayscale',
      ],
    },
    status: {
      // The capsule carries its own dark ground so the timer stays legible over a bright camera frame.
      root: {
        utilities: [
          'pointer-events-none absolute top-2 start-2 z-10 flex items-center gap-2 px-3 py-1.5 rounded-media-pill',
          'bg-(--media-publish-status-background) text-white backdrop-blur-lg backdrop-saturate-150',
          'shadow-[0_0_0_1px_rgb(0_0_0/0.1),0_1px_3px_0_rgb(0_0_0/0.15),inset_0_1px_0_0_rgb(255_255_255/0.1)]',
          'media-2xl:top-3 media-2xl:start-3',
        ],
      },
      badge: {
        utilities: [
          'inline-flex items-center gap-1.5 text-media-sm leading-none font-semibold tracking-wider uppercase whitespace-nowrap',
          'before:inline-block before:size-2 before:shrink-0 before:rounded-media-pill before:bg-current/40',
          'before:transition-[background-color] before:duration-media-fast before:ease-out',
          'data-[publish-state=live]:rounded-media-pill data-[publish-state=live]:bg-media-live',
          'data-[publish-state=live]:px-2 data-[publish-state=live]:py-1 data-[publish-state=live]:before:bg-white',
          'data-[publish-state=error]:rounded-media-pill data-[publish-state=error]:bg-media-live/15',
          'data-[publish-state=error]:px-2 data-[publish-state=error]:py-1 data-[publish-state=error]:text-media-live',
          'motion-safe:data-[publish-state=connecting]:before:animate-pulse',
          'motion-safe:data-[publish-state=live]:before:animate-pulse',
        ],
      },
      timer: {
        // Elapsed publish time only means something while live or stopping.
        utilities: [
          'hidden text-media-sm tabular-nums whitespace-nowrap',
          'data-[publish-state=live]:inline-block data-[publish-state=stopping]:inline-block',
        ],
      },
      connection: {
        utilities: [
          'inline-flex items-center transition-[color,opacity] duration-media-fast ease-out',
          'data-[quality=unknown]:opacity-50',
          'data-[quality=good]:text-(--media-quality-good-color)',
          'data-[quality=fair]:text-(--media-quality-fair-color)',
          'data-[quality=poor]:text-(--media-quality-poor-color)',
        ],
      },
      icon: {
        utilities: 'size-media-icon drop-shadow-media-icon',
      },
    },
    placeholder: {
      // Covers the preview until a local capture stream is active.
      root: {
        utilities: [
          'absolute inset-0 z-5 grid place-content-center rounded-[inherit] text-center text-white',
          'bg-(--media-capture-placeholder-background)',
          'data-[capture-state=active]:hidden',
        ],
      },
      content: {
        utilities: [
          'flex max-w-80 flex-col items-center gap-3 p-4',
          'group-data-[capture-state=acquiring]/placeholder:opacity-70',
        ],
      },
      group: {
        utilities: 'group/placeholder',
      },
      icon: {
        utilities: 'size-media-icon-xl opacity-50',
      },
      message: {
        utilities: [
          'text-media-lg [overflow-wrap:anywhere] opacity-70',
          // Idle and ended would repeat the enable-devices label; only acquiring and denied guidance shows here.
          'data-[capture-state=idle]:hidden data-[capture-state=ended]:hidden',
          'data-[capture-state=denied]:text-media-live data-[capture-state=denied]:opacity-100',
        ],
      },
      enableButton: {
        utilities: [
          ...primaryPill,
          'px-4',
          'data-[capture-state=acquiring]:cursor-progress data-[capture-state=acquiring]:opacity-70',
          'data-[capture-state=acquiring]:active:scale-100',
        ],
      },
    },
  },
});
