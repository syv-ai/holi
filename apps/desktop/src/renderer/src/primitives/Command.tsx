import { Command as CommandPrimitive } from 'cmdk'
import { Search } from 'lucide-react'
import { Icon } from './Icon'
import { cn } from '@/lib/cn'
import { MorphDialog } from './MorphDialog'

/**
 * shadcn's Command (registry `command`, shadcn 4.21, cmdk 1.1.1), for the
 * palette. Every export is the registry's, restyled as the nav menu's
 * family (`MorphingMenu`): its surface, its rows, its springs. One export is
 * composed by hand:
 *
 * `CommandDialog` puts cmdk in `MorphDialog`, the top-anchored surface that
 * morphs in (no dimmed backdrop, no close button), which quick add shares.
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
} & Pick<React.ComponentProps<typeof MorphDialog>, 'onCloseAutoFocus'>

/**
 * The palette: cmdk inside the morphing top-anchored surface (`MorphDialog`).
 * Only the opening rows cascade: a keystroke re-ranks cmdk's list, and a
 * cascade per keystroke would read as flicker.
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
    <MorphDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className={className}
      rows={ROWS}
      bar="[data-slot=command-input-wrapper]"
      onCloseAutoFocus={onCloseAutoFocus}
    >
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
    </MorphDialog>
  )
}

/** The rows that cascade: cmdk's items and the group headings between them. */
const ROWS = '[cmdk-item], [cmdk-group-heading]'

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 px-2.5">
      <Icon icon={Search} tone="muted" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-9 w-full bg-transparent py-2 text-xs outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>): React.JSX.Element {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      // Always-painted scrollbar, so the list's length reads off the thumb.
      className={cn(
        'scrollbar-always max-h-[60vh] scroll-py-1 overflow-x-hidden overflow-y-scroll',
        className,
      )}
      {...props}
    />
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
        "relative flex min-h-8 cursor-default items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-icon",
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
