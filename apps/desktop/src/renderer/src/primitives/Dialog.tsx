import { XIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/cn'

/**
 * The dialog shell. Overlay + focus-trap + portal + Escape/backdrop-close come
 * from Radix (shadcn's dialog primitive); `size` is a guarded union (Replace
 * Primitive with Object), not a free-form string. Feature dialogs stop existing:
 * a content block fills the Header/Body/Footer slots and a registry entry supplies
 * the size. We keep this opinionated `open`/`onClose`/`size` wrapper rather than
 * shadcn's compound API — the block + registry pattern is the grilled house shape;
 * the styling below is shadcn's (animations, close button, tokens).
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full'

// Each size is self-contained: its width AND the layout that width implies.
// sm/md/lg are content-height form dialogs that scroll as one column; `full` is
// a fixed-height workspace modal (VaultHistory's 3-pane git browser) whose body
// scrolls internally, so the modal itself must not become a scroll box.
//
// `[&>*]:min-w-0` is load-bearing, not tidying. A grid child defaults to
// `min-width: auto`, which refuses to shrink below its content — so one long
// unbreakable string (a filename with no spaces) made the whole column wider
// than the panel, and everything laid out against that column went with it. The
// footer is `justify-end`, so its buttons aligned to the right edge of a box
// wider than the visible panel and left the screen entirely: a confirmation
// dialog you could read but not answer. Measured at 544px of content in a 372px
// panel before this.
const panel: Record<DialogSize, string> = {
  sm: 'grid max-h-[85vh] gap-4 overflow-y-auto p-6 max-w-sm [&>*]:min-w-0',
  md: 'grid max-h-[85vh] gap-4 overflow-y-auto p-6 max-w-md [&>*]:min-w-0',
  lg: 'grid max-h-[85vh] gap-4 overflow-y-auto p-6 max-w-2xl [&>*]:min-w-0',
  full: 'flex h-[85vh] flex-col overflow-hidden max-w-6xl [&>*]:min-w-0',
}

type DialogProps = {
  open: boolean
  onClose: () => void
  size?: DialogSize
  /**
   * Show the corner ✕. Default true.
   *
   * Off when the dialog's own footer already offers a way out — a Cancel button
   * beside a corner ✕ is two controls for one intent, and the ✕ is the one with
   * no label. It stays the default because `full`-size workspace modals
   * (VaultHistory) carry no footer at all, and there the ✕ is the only visible
   * way out; Esc and click-outside work either way, but neither is visible.
   */
  closable?: boolean
  children: React.ReactNode
}

export function Dialog({
  open,
  onClose,
  size = 'md',
  closable = true,
  children,
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/50',
            // Motion from the shared tier (index.css), not tw-animate defaults.
            'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
          )}
        />
        <DialogPrimitive.Content
          // We label via Dialog.Header (Radix Title); opt out of the description requirement.
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2',
            // `bg-popover`, like every other floating surface in the app (the
            // context menu, the dropdown). It used to be `bg-background` — the
            // PAGE's own colour — separated from the page by a hairline border
            // and a shadow at 0.1 alpha, which on a near-black background left
            // it reading flat rather than raised. The overlay was carrying that
            // job alone, and `bg-black/50` over an already-black app dims very
            // little. The border goes with it: a raised surface with its own
            // shadow does not need a second edge, which is the reasoning the
            // popover shadow's own comment in index.css already records.
            'rounded-lg bg-popover',
            'text-sm text-popover-foreground shadow-popover outline-none',
            // Motion from the shared tier (index.css): fade + slight zoom on the token easing.
            'data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out',
            panel[size],
          )}
        >
          {children}
          {closable && (
            <DialogPrimitive.Close
              className={cn(
                'absolute right-4 top-4 rounded-xs opacity-70 transition-opacity',
                'hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                'disabled:pointer-events-none',
              )}
            >
              <XIcon className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

Dialog.Header = function DialogHeader({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // `break-words` because a header names things the user chose the name of —
    // a note, a file, a vault — and those arrive with no spaces to wrap at.
    //
    // `pr-6` reserves the close button's corner. It is absolutely positioned, so
    // it takes no space in flow and a long title ran straight underneath it —
    // invisible until a title was long enough to reach, which is exactly when
    // the title matters most.
    <DialogPrimitive.Title className="min-w-0 break-words pr-6 text-sm font-medium text-foreground">
      {children}
    </DialogPrimitive.Title>
  )
}

Dialog.Body = function DialogBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-3">{children}</div>
}

Dialog.Footer = function DialogFooter({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2">{children}</div>
}
