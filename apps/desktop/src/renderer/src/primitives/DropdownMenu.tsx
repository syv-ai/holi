import * as React from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { Icon } from './Icon'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'

import { cn } from '@/lib/cn'
import {
  MORPH_POPUP,
  MORPH_ROW_LOOK,
  MORPH_SURFACE,
  useMorphPopup,
  useMorphRoot,
  useMorphTrigger,
} from './morph-popup'

/** An item's own classes beyond the row look: its icons. */
const ITEM_ICONS = '[&_svg]:pointer-events-none [&_svg]:shrink-0'

/** Opens as the nav menu's family does: out of its trigger (`morph-popup.tsx`). */
function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const morph = useMorphRoot({ open, defaultOpen, onOpenChange })
  return morph.provide(
    <DropdownMenuPrimitive.Root
      data-slot="dropdown-menu"
      open={morph.open}
      onOpenChange={morph.onOpenChange}
      {...props}
    />,
  )
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const triggerRef = useMorphTrigger(ref)
  return (
    <DropdownMenuPrimitive.Trigger ref={triggerRef} data-slot="dropdown-menu-trigger" {...props} />
  )
}

/** The menu, laid over its trigger and grown out of its corner. The rows
 *  scroll inside the surface, so the surface itself never scrolls away. */
function DropdownMenuContent({
  className,
  children,
  align = 'start',
  sideOffset,
  style,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const morph = useMorphPopup()
  const force = morph.mounted || undefined
  return (
    <DropdownMenuPrimitive.Portal forceMount={force}>
      <DropdownMenuPrimitive.Content
        ref={morph.contentRef}
        forceMount={force}
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset ?? morph.sideOffset}
        style={{ ...morph.style, ...style }}
        className={cn(MORPH_POPUP, 'flex flex-col', className)}
        {...props}
      >
        <div ref={morph.surfaceRef} aria-hidden="true" className={MORPH_SURFACE} />
        <div className="max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto overscroll-contain p-1.5">
          {children}
        </div>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-morph-row=""
      data-inset={inset}
      data-variant={variant}
      className={cn(
        MORPH_ROW_LOOK,
        ITEM_ICONS,
        "data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='text-'])]:text-icon data-[variant=destructive]:*:[svg]:text-destructive!",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-morph-row=""
      className={cn(MORPH_ROW_LOOK, ITEM_ICONS, 'pl-8', className)}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Icon icon={Check} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-morph-row=""
      className={cn(MORPH_ROW_LOOK, ITEM_ICONS, 'pl-8', className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <span className="size-2 rounded-full bg-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-morph-row=""
      data-inset={inset}
      className={cn('px-2.5 py-1.5 text-xs text-muted-foreground data-[inset]:pl-8', className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      data-morph-row=""
      className={cn('mx-2.5 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-morph-row=""
      data-inset={inset}
      className={cn(
        MORPH_ROW_LOOK,
        ITEM_ICONS,
        "data-[inset]:pl-8 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*='text-'])]:text-icon",
        className,
      )}
      {...props}
    >
      {children}
      <Icon icon={ChevronRight} className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        'z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-[1.25rem] bg-popover p-1.5 text-popover-foreground shadow-popover data-[state=open]:motion-in-origin data-[state=closed]:motion-out-origin',
        className,
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
