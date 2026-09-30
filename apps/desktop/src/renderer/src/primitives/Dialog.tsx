import { X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { cn } from '@/lib/cn'
import { Icon } from './Icon'
import { rowAt, rowFromMotion, rowGone, rowLeave, spring } from './springs'

/**
 * The dialog shell, in the nav menu's family (`MorphingMenu`, `springs.ts`):
 * the menu's floating surface (`bg-popover`, `shadow-popover`, its radius), no
 * dimmed backdrop, and its motion. The surface springs in from a little
 * smaller while its parts (header, body, footer) cascade up out of a blur, one
 * step behind each other, as the menu's rows do; leaving, they drop away
 * faster than they came. Radix supplies the focus trap, portal and
 * Escape/outside close; the exit is `motion`'s (`forceMount` hands unmounting
 * to `AnimatePresence`, Radix's documented pattern).
 *
 * A content block fills the Header/Body/Footer slots and a registry entry
 * supplies the size, so this keeps an `open`/`onClose`/`size` wrapper rather
 * than shadcn's compound API.
 *
 * `within` puts the dialog inside an element instead of over the window: a
 * question about one thing (an app asking for approval) is asked where that
 * thing is, and the rest of Holi stays usable meanwhile. It is then not modal,
 * and only its own answers or Escape close it.
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full'

// Each size carries its width and the layout it implies: sm/md/lg scroll as one
// column; `full` is a fixed-height modal whose body scrolls internally. `full`
// currently has no consumer.
//
// `[&>*]:min-w-0` is load-bearing: a grid child's `min-width: auto` let one
// unbreakable filename widen the column past the panel, pushing the
// `justify-end` footer buttons off screen.
//
// Roomy on purpose: a dialog is a question to read and weigh, so its padding
// and its gaps are the calm ones, a step wider than a menu's.
const panel: Record<DialogSize, string> = {
  sm: 'grid max-h-[85vh] gap-6 overflow-y-auto p-8 max-w-md [&>*]:min-w-0',
  md: 'grid max-h-[85vh] gap-6 overflow-y-auto p-8 max-w-lg [&>*]:min-w-0',
  lg: 'grid max-h-[85vh] gap-6 overflow-y-auto p-8 max-w-3xl [&>*]:min-w-0',
  full: 'flex h-[85vh] flex-col overflow-hidden max-w-6xl [&>*]:min-w-0',
}

/** The surface: it springs to size, then lets its parts cascade in. */
const shell: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  shown: {
    opacity: 1,
    scale: 1,
    transition: { ...spring, delayChildren: 0.06, staggerChildren: 0.03 },
  },
  gone: { opacity: 0, scale: 0.98, transition: { ...rowLeave, delay: 0.06 } },
}

/** One part: the menu's row motion. */
const part: Variants = {
  hidden: rowFromMotion,
  shown: { ...rowAt, transition: { ...spring, bounce: 0.3 } },
  gone: { ...rowGone, transition: rowLeave },
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
  /** Ask inside this element rather than over the window (see above). It must
   *  be positioned, so the dialog can centre in it. */
  within?: HTMLElement | null
  children: React.ReactNode
}

export function Dialog({
  open,
  onClose,
  size = 'md',
  closable = true,
  within,
  children,
}: DialogProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const contained = within != null
  return (
    <DialogPrimitive.Root
      open={open}
      modal={!contained}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount container={within ?? undefined}>
            {/* No scrim, as the menu has none: it only catches the click outside. */}
            {!contained && (
              <DialogPrimitive.Overlay forceMount className="fixed inset-0 z-50 bg-transparent" />
            )}
            <DialogPrimitive.Content
              forceMount
              asChild
              // We label via Dialog.Header (Radix Title); opt out of the description requirement.
              aria-describedby={undefined}
              // Contained, a click elsewhere in Holi is not an answer.
              onInteractOutside={contained ? (e) => e.preventDefault() : undefined}
            >
              <motion.div
                variants={shell}
                initial={reducedMotion ? false : 'hidden'}
                animate="shown"
                exit={reducedMotion ? undefined : 'gone'}
                className={cn(
                  contained ? 'absolute z-20' : 'fixed z-50',
                  'left-1/2 top-1/2 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2',
                  // The menu's surface: no border, the popover colour and its shadow,
                  // a little see-through over what it is asked about.
                  'rounded-[1.25rem] bg-popover/85 text-sm text-popover-foreground shadow-popover outline-none backdrop-blur-xl',
                  panel[size],
                )}
              >
                {children}
                {closable && (
                  <DialogPrimitive.Close
                    className={cn(
                      'absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-md text-icon motion-respond',
                      'hover:scale-110 hover:bg-accent hover:text-icon-active active:scale-95 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
                      'disabled:pointer-events-none',
                    )}
                  >
                    <Icon icon={X} size="sm" />
                    <span className="sr-only">Close</span>
                  </DialogPrimitive.Close>
                )}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
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
    <DialogPrimitive.Title asChild>
      <motion.h2
        variants={part}
        className="min-w-0 break-words pr-6 text-sm font-medium text-foreground"
      >
        {children}
      </motion.h2>
    </DialogPrimitive.Title>
  )
}

Dialog.Body = function DialogBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <motion.div variants={part} className="flex min-w-0 flex-col gap-4">
      {children}
    </motion.div>
  )
}

Dialog.Footer = function DialogFooter({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Its buttons are pills, the menu's own shape.
    <motion.div
      variants={part}
      className="flex items-center justify-end gap-2 pt-1 *:rounded-full *:px-4"
    >
      {children}
    </motion.div>
  )
}
