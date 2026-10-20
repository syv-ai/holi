import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'

/**
 * The one dialog: Radix's, on the menus' floating surface (`bg-popover` under
 * `shadow-popover`), with no dimmed backdrop. It grows in from its middle and
 * shrinks away with the house's overlay motion (`motion-in-origin`,
 * `motion-out-origin`), the same pair every popup uses; Radix keeps it mounted
 * until the exit animation ends. Radix also supplies the focus trap, portal and
 * Escape/outside close.
 *
 * A content block fills the Header/Body/Footer slots and a registry entry
 * supplies the size, so this keeps an `open`/`onClose`/`size` wrapper rather
 * than shadcn's compound API.
 *
 * `placement="top"` anchors it near the top of the window instead of centring
 * it: the command palette and quick add, whose height changes as you type and
 * which should not jump about the middle of the screen while it does.
 *
 * `within` puts the dialog inside an element instead of over the window: a
 * question about one thing (an app asking for approval) is asked where that
 * thing is, and the rest of Holi stays usable meanwhile. It is then not modal,
 * and only its own answers or Escape close it.
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full' | 'bare'

// Each size carries its width and the layout it implies: sm/md/lg scroll as one
// column; `full` is a fixed-height modal whose body scrolls internally; `bare`
// is a surface with only a little padding, for content that brings its own
// layout (the palette, quick add).
//
// `[&>*]:min-w-0` is load-bearing: a grid child's `min-width: auto` let one
// unbreakable filename widen the column past the panel, pushing the
// `justify-end` footer buttons off screen.
const panel: Record<DialogSize, string> = {
  sm: 'grid max-h-[85vh] gap-6 overflow-y-auto p-6 max-w-md [&>*]:min-w-0',
  md: 'grid max-h-[85vh] gap-6 overflow-y-auto p-6 max-w-lg [&>*]:min-w-0',
  lg: 'grid max-h-[85vh] gap-6 overflow-y-auto p-6 max-w-3xl [&>*]:min-w-0',
  full: 'flex h-[85vh] flex-col overflow-hidden max-w-6xl [&>*]:min-w-0',
  bare: 'max-h-[85vh] overflow-hidden p-1.5 max-w-xl',
}

/**
 * A floating layer that belongs to something inside a dialog but has to live
 * outside it to show in full (quick add's completion list, which the dialog
 * would clip). Marked with this attribute, a press in it counts as inside.
 */
export const DIALOG_OWNED = 'data-dialog-owned'
const isDialogOwned = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${DIALOG_OWNED}]`) !== null

type DialogProps = {
  open: boolean
  onClose: () => void
  size?: DialogSize
  /** Centred (default) or anchored near the top of the window. */
  placement?: 'center' | 'top'
  /**
   * Show the corner ✕. Default true, since Esc and click-outside are not
   * visible. Turn it off when the footer already has a Cancel.
   */
  closable?: boolean
  /** Ask inside this element rather than over the window (see above). It must
   *  be positioned, so the dialog can centre in it. */
  within?: HTMLElement | null
  /** A visually hidden title and description, for a dialog with no
   *  `Dialog.Header` (the palette): Radix needs one for the dialog role. */
  title?: string
  description?: string
  className?: string
} & Pick<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  'onCloseAutoFocus' | 'onEscapeKeyDown' | 'onOpenAutoFocus'
> & { children: React.ReactNode }

export function Dialog({
  open,
  onClose,
  size = 'md',
  placement = 'center',
  closable = true,
  within,
  title,
  description,
  className,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onOpenAutoFocus,
  children,
}: DialogProps): React.JSX.Element {
  const contained = within != null
  return (
    <DialogPrimitive.Root
      open={open}
      modal={!contained}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPrimitive.Portal container={within ?? undefined}>
        {/* No scrim, as the menus have none: it only catches the click outside. */}
        {!contained && <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-transparent" />}
        <DialogPrimitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={onOpenAutoFocus}
          onInteractOutside={(event) => {
            // Contained, a click elsewhere in Holi is not an answer; and a
            // layer the dialog owns is inside it.
            if (contained || isDialogOwned(event.target)) event.preventDefault()
          }}
          className={cn(
            contained ? 'absolute z-20' : 'fixed z-50',
            'left-1/2 w-[calc(100%-2rem)] -translate-x-1/2',
            placement === 'top' ? 'top-[12vh]' : 'top-1/2 -translate-y-1/2',
            'rounded-xl bg-popover text-sm text-popover-foreground shadow-popover outline-none',
            placement === 'top' ? 'origin-top' : 'origin-center',
            'data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
            panel[size],
            className,
          )}
          // Without a description, opt out of Radix's requirement for one.
          {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          {title !== undefined && (
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          )}
          {description !== undefined && (
            <DialogPrimitive.Description className="sr-only">
              {description}
            </DialogPrimitive.Description>
          )}
          {children}
          {closable && (
            <DialogPrimitive.Close
              className={cn(
                'absolute top-4 right-4 inline-flex size-6 items-center justify-center rounded-md text-icon motion-respond',
                'hover:bg-accent hover:text-icon-active focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
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
    <DialogPrimitive.Title className="min-w-0 pr-6 text-sm font-medium break-words text-foreground">
      {children}
    </DialogPrimitive.Title>
  )
}

Dialog.Body = function DialogBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex min-w-0 flex-col gap-4">{children}</div>
}

Dialog.Footer = function DialogFooter({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2">{children}</div>
}
