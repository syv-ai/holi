import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/cn'

// The shared bits every input keeps (selection colour, disabled, placeholder).
// Per-look geometry/typography lives in the variants.
const inputVariants = cva(
  'w-full min-w-0 bg-transparent outline-none motion-respond selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        // The stock shadcn field.
        default:
          'h-9 rounded-md border border-input px-3 py-1 text-base shadow-xs file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground md:text-sm dark:bg-input/30 focus-visible:border-ring aria-invalid:border-destructive',
        // No box of its own: the text-entry part of a control whose box is
        // something else (a chip field), so the two never read as nested fields.
        bare: 'h-auto border-0 p-0',
        // Onboarding ritual: the giant serif vault-name display input.
        display:
          "border-0 p-0 text-center text-[80px] font-medium leading-[1.05] tracking-[-0.028em] [font-family:'Fraunces',serif] [font-variation-settings:'opsz'_144,'SOFT'_50]",
        // Onboarding ritual: a serif field with only an underline that lights on focus.
        underline:
          "border-0 border-b border-input px-0.5 py-2 text-[19px] leading-[1.4] [font-family:'Newsreader',serif] [font-variation-settings:'opsz'_22] focus-visible:border-ring",
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

// forwardRef (the pre-React-19 shadcn form): this project is on React 18, where a
// plain function component silently drops a `ref`. Consumers that hand the input
// a ref — e.g. headless-tree's getRenameInputProps(), whose callback ref focuses
// the rename field — need it to reach the DOM node.
const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & VariantProps<typeof inputVariants>
>(({ className, type, variant, ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant, className }))}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input, inputVariants }
