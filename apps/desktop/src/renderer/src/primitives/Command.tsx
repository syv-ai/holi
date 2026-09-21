import { Command as CommandPrimitive } from 'cmdk'
import { SearchIcon } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'

/**
 * shadcn's Command (registry `command`, shadcn 4.21, cmdk 1.1.1), for the
 * palette (D102). Every export is the registry's, with one exception:
 *
 * **`CommandDialog` composes Radix directly.** The registry item builds it from
 * shadcn's compound `Dialog`/`DialogContent`/`DialogHeader`, which this repo
 * deliberately does not have — `Dialog.tsx` is an opinionated
 * `{open, onClose, size}` wrapper, and a palette is a different overlay class
 * from a form dialog: top-anchored, no dimmed backdrop, no close button,
 * VS Code's shape. Radix still gives it the portal, focus trap, Escape and
 * focus return; the overlay is transparent so a click outside closes without
 * ever having darkened the page.
 *
 * Filtering is the caller's: the palette runs `shouldFilter={false}` and ranks
 * with the same pure function its node tests use (`lib/palette-rows.ts`).
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
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-transparent" />
        <DialogPrimitive.Content
          data-slot="command-dialog"
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden p-0',
            'rounded-lg bg-popover text-sm text-popover-foreground shadow-popover outline-none',
            'data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
            className,
          )}
        >
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
            className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
          >
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 px-3">
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

/**
 * Mark on `frame` which edges of the scroller `ref` have rows beyond them, so
 * `.scroll-edges` (index.css) can shade them. Re-measured on scroll and
 * whenever the content resizes, which is what a filtered list does on every
 * keystroke. The marks go on the frame around the scroller rather than on it,
 * so the shade can span the scrollbar's gutter.
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
        // Taller than the registry's 300px, and the scrollbar is always painted
        // (`.scrollbar-always`, index.css) so the list's length can be read off
        // the thumb rather than discovered by scrolling.
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
      className="py-6 text-center text-sm"
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
        'overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground',
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
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
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
