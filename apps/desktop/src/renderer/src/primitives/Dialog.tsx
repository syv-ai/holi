import { X } from 'lucide-react'
import { Icon } from './Icon'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/cn'

/**
 * The dialog shell: Radix (shadcn's dialog primitive) supplies overlay, focus
 * trap, portal and Escape/backdrop close. A content block fills the
 * Header/Body/Footer slots and a registry entry supplies the size, so this
 * keeps an `open`/`onClose`/`size` wrapper rather than shadcn's compound API.
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full'

// Each size carries its width and the layout it implies: sm/md/lg scroll as one
// column; `full` is a fixed-height modal whose body scrolls internally. `full`
// currently has no consumer.
//
// `[&>*]:min-w-0` is load-bearing: a grid child's `min-width: auto` let one
// unbreakable filename widen the column past the panel, pushing the
// `justify-end` footer buttons off screen.
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
   * Show the corner ✕. Default true, since Esc and click-outside are not
   * visible. Turn it off when the footer already has a Cancel.
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
            'data-[state=open]:motion-in-fade data-[state=closed]:motion-out-fade',
          )}
        />
        <DialogPrimitive.Content
          // We label via Dialog.Header (Radix Title); opt out of the description requirement.
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2',
            // `bg-popover` and a shadow, no border, like every floating surface:
            // the page colour read flat on a near-black app.
            'rounded-lg bg-popover',
            'text-sm text-popover-foreground shadow-popover outline-none',
            // Motion from the shared tier (index.css): fade + slight zoom on the token easing.
            'data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
            panel[size],
          )}
        >
          {children}
          {closable && (
            <DialogPrimitive.Close
              className={cn(
                'absolute right-3 top-3 inline-flex size-6 items-center justify-center rounded-md text-icon motion-respond',
                'hover:scale-110 hover:bg-accent hover:text-icon-active active:scale-95 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
                'disabled:pointer-events-none',
              )}
            >
              <Icon icon={X} size="sm" />
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
    // `break-words`: user-chosen names arrive with no spaces to wrap at.
    // `pr-6` reserves the absolutely positioned close button's corner.
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
