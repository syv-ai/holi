import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'
import { AnimatePresence, useAnimate, usePresence, useReducedMotion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { MOTION_STAGGER_CAP } from '@/lib/motion'
import { compress, PILL, rowAt, rowArrive, rowFrom, rowGone, rowLeave, spring } from './springs'

/**
 * shadcn's Command (registry `command`, shadcn 4.21, cmdk 1.1.1), for the
 * palette (D102). Every export is the registry's, restyled as the nav menu's
 * family (`MorphingMenu`): its surface, its rows, its springs. One export is
 * composed by hand:
 *
 * `CommandDialog` composes Radix directly: this repo has no compound shadcn
 * `Dialog`, and a palette is a different overlay from a form dialog
 * (top-anchored, no dimmed backdrop, no close button). The overlay is
 * transparent so a click outside still closes.
 *
 * Filtering is the caller's (`lib/palette-rows.ts`, `shouldFilter={false}`).
 */
function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>): React.JSX.Element {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}

type CommandDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Radix requires a title and a description for the dialog role; both are
   *  visually hidden, the way the registry item hides them. */
  title?: string
  description?: string
  className?: string
  /** cmdk filters by item value unless told not to. The palette ranks with
   *  its own pure function and passes `false`. */
  shouldFilter?: boolean
  children: React.ReactNode
} & Pick<React.ComponentProps<typeof DialogPrimitive.Content>, 'onCloseAutoFocus'>

/**
 * The exit is `motion`'s, not Radix's: `forceMount` hands unmounting to
 * `AnimatePresence`, which keeps the portal until the shell has played its
 * exit (Radix's documented pattern for a JS animation library). Radix drops
 * the focus trap and the outside-pointer block the moment `open` turns false,
 * so a chosen row that focuses a terminal is not pulled back during it.
 */
function CommandDialog({
  open,
  onOpenChange,
  title = 'Command palette',
  description = 'Search for something to open or a command to run',
  className,
  shouldFilter,
  children,
  onCloseAutoFocus,
}: CommandDialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay
              forceMount
              className="fixed inset-0 z-50 bg-transparent data-[state=closed]:pointer-events-none"
            />
            <MorphingShell className={className} onCloseAutoFocus={onCloseAutoFocus}>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {description}
              </DialogPrimitive.Description>
              <Command
                shouldFilter={shouldFilter}
                // cmdk's Ctrl+J/K/N/P defaults collide with the app's own keys off
                // macOS, where ⌘ in a hotkey glyph means Ctrl (`lib/hotkey.ts`).
                vimBindings={false}
                // ↑ on the first row lands on the last, and ↓ on the last on the first.
                loop
                className="rounded-none bg-transparent"
              >
                {children}
              </Command>
            </MorphingShell>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}

/** The rows that cascade: cmdk's items and the group headings between them. */
const ROWS = '[cmdk-item], [cmdk-group-heading]'

/**
 * The palette's surface, morphing the way the nav menu's does. Opening, it
 * appears as a pill, then springs to its size while the rows it opened with
 * cascade in; closing, the rows drop away and it squeezes back to the pill as
 * it fades. Only the opening rows cascade: a keystroke re-ranks cmdk's list,
 * and a cascade per keystroke would read as flicker.
 *
 * The shell is sized in px only while it moves, measured off the content,
 * which has a fixed width so nothing re-wraps under the spring. Settled, the
 * size is cleared and follows the list as it filters.
 */
function MorphingShell({
  className,
  onCloseAutoFocus,
  children,
}: {
  className?: string
  onCloseAutoFocus: CommandDialogProps['onCloseAutoFocus']
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
    const rows = [...content.querySelectorAll<HTMLElement>(ROWS)]
    const pill = { width: Math.min(content.offsetWidth, 200), height: PILL }
    const running: ReturnType<typeof animate>[] = []
    let cancelled = false
    const track = (animation: ReturnType<typeof animate>) => {
      running.push(animation)
      return animation
    }
    const settle = () => Object.assign(shell.style, { width: '', height: '' })

    if (present) {
      if (reducedMotion) {
        settle()
        Object.assign(shell.style, { opacity: '' })
      } else {
        // Reopened mid-exit, it grows back from wherever the exit left it.
        if (arriving) {
          Object.assign(shell.style, { width: `${pill.width}px`, height: `${pill.height}px` })
          shell.style.opacity = '0'
          rows.forEach((row) => Object.assign(row.style, rowFrom))
        }
        track(animate(shell, { opacity: 1 }, compress))
        const grow = track(
          animate(
            shell,
            { width: content.offsetWidth, height: content.offsetHeight },
            { ...spring, delay: compress.duration },
          ),
        )
        void grow.finished.then(() => !cancelled && settle()).catch(() => {})
        rows.forEach((row, index) =>
          track(
            animate(
              row,
              rowAt,
              arriving
                ? rowArrive(Math.min(index, MOTION_STAGGER_CAP))
                : { ...spring, duration: 0.25 },
            ),
          ),
        )
      }
    } else if (reducedMotion) {
      safeToRemove()
    } else {
      Object.assign(shell.style, {
        width: `${shell.offsetWidth}px`,
        height: `${shell.offsetHeight}px`,
      })
      rows.forEach((row) => track(animate(row, rowGone, rowLeave)))
      track(animate(shell, pill, { ...spring, duration: 0.25, bounce: 0 }))
      const fade = track(animate(shell, { opacity: 0 }, { ...compress, delay: rowLeave.duration }))
      void fade.finished.then(() => !cancelled && safeToRemove()).catch(() => {})
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
      data-slot="command-dialog"
      onCloseAutoFocus={onCloseAutoFocus}
      className={cn(
        'fixed inset-x-0 top-[12vh] z-50 mx-auto w-fit overflow-hidden rounded-[1.25rem] p-0',
        'bg-popover text-sm text-popover-foreground shadow-popover outline-none',
        'data-[state=closed]:pointer-events-none',
        className,
      )}
    >
      <div ref={contentRef} className="w-[min(36rem,calc(100vw-2rem))] p-1.5">
        {children}
      </div>
    </DialogPrimitive.Content>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div data-slot="command-input-wrapper" className="flex h-10 items-center gap-2 px-2.5">
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-10 w-full bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

/**
 * Mark on `frame` which edges of the scroller `ref` have rows beyond them, so
 * `.scroll-edges` (index.css) can shade them. Re-measured on scroll and on
 * content resize (every filter keystroke).
 */
function useScrollEdges(
  ref: React.RefObject<HTMLDivElement | null>,
  frame: React.RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const el = ref.current
    const box = frame.current
    if (el === null || box === null) return
    const measure = (): void => {
      box.dataset.scrollTop = String(el.scrollTop > 0)
      box.dataset.scrollBottom = String(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    for (const child of el.children) observer?.observe(child)
    return () => {
      el.removeEventListener('scroll', measure)
      observer?.disconnect()
    }
  }, [ref, frame])
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  useScrollEdges(ref, frame)
  return (
    // The frame carries the edge shades (`.scroll-edges`) over the whole width,
    // scrollbar included; the list inside is the scroller.
    <div ref={frame} className="scroll-edges">
      <CommandPrimitive.List
        ref={ref}
        data-slot="command-list"
        // Always-painted scrollbar, so the list's length reads off the thumb.
        className={cn(
          'scrollbar-always max-h-[60vh] scroll-py-1 overflow-x-hidden overflow-y-scroll',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandEmpty(
  props: React.ComponentProps<typeof CommandPrimitive.Empty>,
): React.JSX.Element {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm text-muted-foreground"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>): React.JSX.Element {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>): React.JSX.Element {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex min-h-8 cursor-default items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
