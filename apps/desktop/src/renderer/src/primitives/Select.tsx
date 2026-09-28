import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { Icon } from './Icon'
import { Select as SelectPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'
import { FIELD_LOOK } from './field-look'
import {
  MORPH_POPUP,
  MORPH_ROW_LOOK,
  MORPH_SURFACE,
  useMorphPopup,
  useMorphRoot,
  useMorphTrigger,
} from './morph-popup'

const selectTriggerVariants = cva(
  "flex items-center justify-between gap-2 whitespace-nowrap outline-none motion-respond disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-icon aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          'w-fit rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:border-ring data-[size=default]:h-9 data-[size=sm]:h-8 dark:bg-input/30 dark:hover:bg-input/50',
        // A value in a labelled row: `field-look.ts`.
        field: FIELD_LOOK,
        // Onboarding ritual: a serif field with only an underline, matching the
        // Input `underline` variant so a select and a text field read as siblings.
        underline:
          "w-full rounded-none border-0 border-b border-input bg-transparent px-0.5 py-2 text-[19px] leading-[1.4] [font-family:'Newsreader',serif] [font-variation-settings:'opsz'_22] focus-visible:border-ring",
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

/** Opens as the nav menu's family does: out of its trigger (`morph-popup.tsx`). */
function Select({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const morph = useMorphRoot({ open, defaultOpen, onOpenChange })
  return morph.provide(
    <SelectPrimitive.Root
      data-slot="select"
      open={morph.open}
      onOpenChange={morph.onOpenChange}
      {...props}
    />,
  )
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  variant,
  children,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default'
} & VariantProps<typeof selectTriggerVariants>) {
  const triggerRef = useMorphTrigger(ref)
  return (
    <SelectPrimitive.Trigger
      ref={triggerRef}
      data-slot="select-trigger"
      data-size={size}
      className={cn(selectTriggerVariants({ variant, className }))}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex text-icon">
        <Icon icon={ChevronDown} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/**
 * The list, laid over its trigger and grown out of it. Popper-positioned, not
 * Radix's item-aligned default: the surface grows from the trigger's corner,
 * so the list's first row starts where the trigger was.
 */
function SelectContent({
  className,
  children,
  position = 'popper',
  align = 'start',
  sideOffset,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const morph = useMorphPopup()
  const force = morph.mounted || undefined
  return (
    <SelectPrimitive.Portal forceMount={force}>
      <SelectPrimitive.Content
        ref={morph.contentRef}
        forceMount={force}
        data-slot="select-content"
        className={cn(MORPH_POPUP, 'max-h-(--radix-select-content-available-height)', className)}
        position={position}
        align={align}
        sideOffset={sideOffset ?? morph.sideOffset}
        style={{ ...morph.style, ...style }}
        {...props}
      >
        <div ref={morph.surfaceRef} aria-hidden="true" className={MORPH_SURFACE} />
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="scroll-my-1.5 p-1.5">
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      data-morph-row=""
      className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      data-morph-row=""
      className={cn(
        MORPH_ROW_LOOK,
        "pr-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-icon *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2.5 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <Icon icon={Check} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      data-morph-row=""
      className={cn('pointer-events-none mx-2.5 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <Icon icon={ChevronUp} />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <Icon icon={ChevronDown} />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
