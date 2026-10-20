/**
 * shadcn's input-group (radix-nova), vendored: one field with things inside its
 * edges, an icon before the text and buttons after it (ReUI's search with a
 * selector, `c-input-group-38`, is the pattern).
 *
 * The house text-field look replaces upstream's box (`field-look.ts`): a grey
 * fill and no edge, the caret as the focus, so the group reads as the field it
 * is and grows no halo. Its parts are `Input`'s `bare` look and `Button`; an
 * icon-only control inside it is an `IconButton`, as everywhere.
 */
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/cn'
import { Button } from './Button'
import { TEXT_FIELD_LOOK } from './field-look'
import { Input } from './Input'

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        TEXT_FIELD_LOOK,
        'group/input-group relative flex h-9 w-full min-w-0 items-center rounded-lg motion-respond has-disabled:opacity-50 has-[[data-slot][aria-invalid=true]]:bg-destructive/15 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=inline-start]]:[&>input]:ps-1.5',
        className,
      )}
      {...props}
    />
  )
}

const inputGroupAddonVariants = cva(
  'flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50',
  {
    variants: {
      align: {
        'inline-start': 'order-first ps-2.5 has-[>button]:-ms-1',
        'inline-end': 'order-last pe-1.5 has-[>button]:-me-0.5',
      },
    },
    defaultVariants: { align: 'inline-start' },
  },
)

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      // A press on the addon's padding focuses the field; one on a button is
      // that button's.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        e.currentTarget.parentElement?.querySelector('input')?.focus()
      }}
      {...props}
    />
  )
}

/** A text button inside the field (a selector's trigger). */
const InputGroupButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ComponentProps<typeof Button>, 'size'>
>(({ className, type = 'button', variant = 'ghost', ...props }, ref) => (
  <Button
    ref={ref}
    type={type}
    variant={variant}
    size="xs"
    className={cn('shadow-none', className)}
    {...props}
  />
))
InputGroupButton.displayName = 'InputGroupButton'

function InputGroupInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <Input
      data-slot="input-group-control"
      variant="bare"
      className={cn('h-full flex-1 px-2.5 text-sm', className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput }
