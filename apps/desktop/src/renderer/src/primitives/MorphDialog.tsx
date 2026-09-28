/**
 * A top-anchored surface that morphs in: the command palette's, and quick
 * add's off the board. A form dialog (`Dialog`) is a different overlay: this
 * one has no dimmed backdrop and no close button, and it opens as a bar that
 * widens, then drops to its full height with its rows cascading in (the nav
 * menu's family: `springs.ts`). The overlay is transparent, so a click outside
 * still closes.
 *
 * The exit is `motion`'s, not Radix's: `forceMount` hands unmounting to
 * `AnimatePresence`, which keeps the portal until the shell has played its
 * exit (Radix's documented pattern for a JS animation library).
 */
import { AnimatePresence, useAnimate, usePresence, useReducedMotion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { MOTION_STAGGER_CAP } from '@/lib/motion'
import { PILL, rowAt, rowArrive, rowFrom, rowGone, rowLeave, spring } from './springs'

export type MorphDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Radix requires a title and a description for the dialog role; both are
   *  visually hidden. */
  title: string
  description: string
  className?: string
  /** What cascades in: the content's rows. */
  rows?: string
  /** The element the opening bar is as tall as (a search field); a pill when
   *  absent. */
  bar?: string
  /** The content's fixed width: nothing re-wraps under the spring. */
  width?: string
  children: React.ReactNode
} & Pick<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  'onCloseAutoFocus' | 'onEscapeKeyDown'
>

export function MorphDialog({
  open,
  onOpenChange,
  title,
  description,
  className,
  rows = '[data-morph-row]',
  bar,
  width = 'w-[min(36rem,calc(100vw-2rem))]',
  children,
  onCloseAutoFocus,
  onEscapeKeyDown,
}: MorphDialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay
              forceMount
              className="fixed inset-0 z-50 bg-transparent data-[state=closed]:pointer-events-none"
            />
            <MorphingShell
              className={className}
              onCloseAutoFocus={onCloseAutoFocus}
              onEscapeKeyDown={onEscapeKeyDown}
              rows={rows}
              bar={bar}
              width={width}
            >
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {description}
              </DialogPrimitive.Description>
              {children}
            </MorphingShell>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}

/** The sequence, in seconds: it widens as a bar, its input shows, then it
 *  drops to its full height with the rows cascading in. Quick, since it is
 *  on the path of a keystroke. */
const appear = { duration: 0.08 } as const
const widen = { ...spring, duration: 0.22, bounce: 0.12 } as const
const showInput = { duration: 0.1, delay: 0.14 } as const
const drop = { ...spring, duration: 0.3, bounce: 0.08, delay: 0.16 } as const
/** Calmer than the menu's rows: the palette opens many times a day, so its
 *  landing only just settles rather than bouncing back. */
const ROW_BOUNCE = 0.12
const ROWS_AFTER = 0.2
const lift = { ...spring, duration: 0.18, bounce: 0 } as const
const narrow = { ...spring, duration: 0.15, bounce: 0, delay: 0.1 } as const
const vanish = { duration: 0.1, delay: 0.14 } as const

/**
 * The palette's surface, morphing in the nav menu's springs. Opening, it
 * appears as a short bar the height of its input, widens to its full width,
 * shows the input, then drops to its full height while the rows it opened
 * with cascade in. Closing runs it backwards: the rows drop away, it lifts to
 * the bar, narrows and fades. Only the opening rows cascade: a keystroke
 * re-ranks cmdk's list, and a cascade per keystroke would read as flicker.
 *
 * The shell is sized in px only while it moves, measured off the content,
 * which has a fixed width so nothing re-wraps under the spring, and the input
 * is hidden while it widens so its text does not slide with the left edge.
 * Settled, the size is cleared and follows the list as it filters.
 */
function MorphingShell({
  className,
  onCloseAutoFocus,
  onEscapeKeyDown,
  rows: rowSelector,
  bar: barSelector,
  width,
  children,
}: {
  className?: string
  onCloseAutoFocus: MorphDialogProps['onCloseAutoFocus']
  onEscapeKeyDown: MorphDialogProps['onEscapeKeyDown']
  rows: string
  bar?: string
  width: string
  children: React.ReactNode
}): React.JSX.Element {
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const contentRef = useRef<HTMLDivElement>(null)
  const [present, safeToRemove] = usePresence()
  const reducedMotion = useReducedMotion() ?? false
  /** Closed and still playing its exit: an open now is a reopen, not an
   *  arrival. Not a "has mounted" flag, which StrictMode's second effect run
   *  would read as a reopen. */
  const exiting = useRef(false)

  useLayoutEffect(() => {
    const shell = scope.current
    const content = contentRef.current
    if (!shell || !content) return
    const arriving = present && !exiting.current
    exiting.current = !present
    const rows = [...content.querySelectorAll<HTMLElement>(rowSelector)]
    const input = barSelector ? content.querySelector<HTMLElement>(barSelector) : null
    // The bar is the input row and the shell's padding under it: the shell is
    // `fixed`, so it is the input's offset parent.
    const bar = {
      width: Math.min(content.offsetWidth, 200),
      height: input
        ? input.offsetTop + input.offsetHeight + parseFloat(getComputedStyle(content).paddingBottom)
        : PILL,
    }
    const full = { width: content.offsetWidth, height: content.offsetHeight }
    const running: ReturnType<typeof animate>[] = []
    let cancelled = false
    const track = (animation: ReturnType<typeof animate>) => {
      running.push(animation)
      return animation
    }
    // The list's scrollbar shows once the shell has its size (`index.css`).
    const settle = () => {
      Object.assign(shell.style, { width: '', height: '' })
      delete shell.dataset.morphing
    }
    const whenDone = (animations: ReturnType<typeof animate>[], then: () => void) =>
      void Promise.all(animations.map((animation) => animation.finished))
        .then(() => !cancelled && then())
        .catch(() => {})

    if (present) {
      if (reducedMotion) {
        settle()
        shell.style.opacity = ''
        if (input) input.style.opacity = ''
      } else if (arriving) {
        shell.dataset.morphing = ''
        Object.assign(shell.style, {
          width: `${bar.width}px`,
          height: `${bar.height}px`,
          opacity: '0',
        })
        if (input) input.style.opacity = '0'
        rows.forEach((row) => Object.assign(row.style, rowFrom))
        track(animate(shell, { opacity: 1 }, appear))
        if (input) track(animate(input, { opacity: 1 }, showInput))
        whenDone(
          [
            track(animate(shell, { width: full.width }, widen)),
            track(animate(shell, { height: full.height }, drop)),
          ],
          settle,
        )
        rows.forEach((row, index) =>
          track(
            animate(row, rowAt, {
              ...rowArrive(Math.min(index, MOTION_STAGGER_CAP), ROWS_AFTER),
              bounce: ROW_BOUNCE,
            }),
          ),
        )
      } else {
        // Reopened mid-exit: it grows back from wherever the exit left it.
        shell.dataset.morphing = ''
        track(animate(shell, { opacity: 1 }, appear))
        if (input) track(animate(input, { opacity: 1 }, appear))
        whenDone([track(animate(shell, full, { ...widen, delay: 0 }))], settle)
        rows.forEach((row) => track(animate(row, rowAt, { ...spring, duration: 0.25 })))
      }
    } else if (reducedMotion) {
      safeToRemove()
    } else {
      shell.dataset.morphing = ''
      Object.assign(shell.style, {
        width: `${shell.offsetWidth}px`,
        height: `${shell.offsetHeight}px`,
      })
      rows.forEach((row) => track(animate(row, rowGone, rowLeave)))
      if (input) track(animate(input, { opacity: 0 }, appear))
      track(animate(shell, { height: bar.height }, lift))
      track(animate(shell, { width: bar.width }, narrow))
      whenDone([track(animate(shell, { opacity: 0 }, vanish))], safeToRemove)
    }
    return () => {
      cancelled = true
      running.forEach((animation) => animation.stop())
    }
    // `animate` and `scope` are stable; a re-rank must not replay the morph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, reducedMotion])

  return (
    <DialogPrimitive.Content
      forceMount
      ref={scope}
      data-slot="morph-dialog"
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
      className={cn(
        'fixed inset-x-0 top-[12vh] z-50 mx-auto w-fit overflow-hidden rounded-[1.25rem] p-0',
        'bg-popover text-sm text-popover-foreground shadow-popover outline-none',
        'data-[state=closed]:pointer-events-none',
        className,
      )}
    >
      <div ref={contentRef} className={cn(width, 'p-1.5')}>
        {children}
      </div>
    </DialogPrimitive.Content>
  )
}
