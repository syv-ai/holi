import { type VariantProps, cva } from 'class-variance-authority'
import { cn } from '@/lib/cn'

/**
 * The button primitive. Absorbs the ~6 copy-pasted className dialects and the
 * `on ? a : b` inline toggles into a variant map (Strategy) over semantic tokens.
 * Hover shades are DERIVED (`bg-accent/90` → color-mix), not a second token, and
 * the focus ring names a token because v4's ring default is currentColor/1px.
 */
const button = cva(
  'inline-flex items-center justify-center rounded-control text-sm font-medium transition-colors ' +
    'outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
    'disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        solid: 'bg-accent text-accent-fg hover:bg-accent/90',
        surface: 'bg-surface-raised text-foreground border border-border hover:bg-surface-raised/80',
        ghost: 'bg-transparent text-muted-fg hover:text-foreground hover:bg-surface-raised/60',
        danger: 'bg-danger text-danger-fg hover:bg-danger/90',
        link: 'bg-transparent text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        lg: 'h-10 px-5',
      },
    },
    defaultVariants: { variant: 'solid', size: 'md' },
  },
)

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof button>

export function Button({ className, variant, size, type, ...props }: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type ?? 'button'}
      data-slot="button"
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  )
}
