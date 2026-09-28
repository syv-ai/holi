/**
 * shadcn's `combobox` (Base UI), trimmed to the chips mode in use and restyled
 * onto this app's tokens: the popover surface and `.shadow-popover`, the
 * arrive/leave motion (Base UI waits for the leave animation on
 * `data-ending-style`), and the one focus treatment instead of upstream's
 * 3px halo. Add upstream's other parts when something needs them.
 */
import * as React from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { cva, type VariantProps } from 'class-variance-authority'
import { X } from 'lucide-react'
import { Icon } from './Icon'

import { cn } from '@/lib/cn'
import { FIELD_LOOK } from './field-look'

const Combobox = ComboboxPrimitive.Root

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, 'side' | 'align' | 'sideOffset' | 'anchor'>) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        anchor={anchor}
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            'group/combobox-content max-h-72 w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-md bg-popover text-popover-foreground shadow-popover outline-hidden',
            'motion-in-origin data-ending-style:motion-out-origin',
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn('max-h-72 scroll-py-1 overflow-y-auto p-1 data-empty:p-0', className)}
      {...props}
    />
  )
}

function ComboboxItem({ className, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        'motion-respond relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  )
}

const comboboxChipsVariants = cva(
  'flex flex-wrap items-center gap-1 text-sm has-aria-invalid:border-destructive',
  {
    variants: {
      variant: {
        default:
          'min-h-9 rounded-md border border-input bg-transparent px-1.5 py-1.5 shadow-xs focus-within:border-ring dark:bg-input/30',
        // A value in a labelled row (`field-look.ts`), grown to wrap its chips.
        field: `${FIELD_LOOK} h-auto min-h-8 py-1`,
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function ComboboxChips({
  className,
  variant,
  ...props
}: React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
  ComboboxPrimitive.Chips.Props &
  VariantProps<typeof comboboxChipsVariants>) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn(comboboxChipsVariants({ variant, className }))}
      {...props}
    />
  )
}

function ComboboxChip({
  className,
  children,
  removeLabel,
  ...props
}: ComboboxPrimitive.Chip.Props & {
  /** The remove button's name; no button without one. */
  removeLabel?: string
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        'flex h-5 w-fit items-center justify-center gap-1 rounded-sm bg-muted px-1.5 text-xs whitespace-nowrap text-foreground has-data-[slot=combobox-chip-remove]:pr-0',
        className,
      )}
      {...props}
    >
      {children}
      {removeLabel !== undefined && (
        <ComboboxPrimitive.ChipRemove
          className="-mr-0.5 inline-flex size-4 items-center justify-center rounded-sm text-icon outline-none motion-respond hover:scale-110 hover:text-icon-active focus-visible:ring-1 focus-visible:ring-ring"
          data-slot="combobox-chip-remove"
          aria-label={removeLabel}
        >
          <Icon icon={X} size="sm" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  )
}

function ComboboxChipsInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn(
        'min-w-12 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
}
