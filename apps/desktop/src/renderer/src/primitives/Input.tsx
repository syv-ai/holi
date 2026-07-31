import { cn } from '@/lib/cn'

/**
 * The text-input primitive. Replaces the `taskFieldInput`/`control` string
 * constants that were re-derived across four files (and exported upward out of
 * TaskDetail, a feature — the inverted seam this un-inverts).
 */
export function Input({ className, ...props }: React.ComponentProps<'input'>): React.JSX.Element {
  return (
    <input
      data-slot="input"
      className={cn(
        'w-full rounded-control border border-border bg-surface-raised px-2 py-1',
        'text-sm text-foreground outline-none placeholder:text-muted-fg',
        'focus:border-accent disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
