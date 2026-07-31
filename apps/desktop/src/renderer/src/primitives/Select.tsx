import { cn } from '@/lib/cn'

/**
 * The native-select primitive. The tracer's CreateTask needs status/priority
 * pickers, and a feature may not render a raw <select>; this is the one place it
 * lives. (A richer Radix combobox is a follow-on when search/keyboard nav is due.)
 */
export function Select({ className, ...props }: React.ComponentProps<'select'>): React.JSX.Element {
  return (
    <select
      data-slot="select"
      className={cn(
        'w-full rounded-control border border-border bg-surface-raised px-2 py-1',
        'text-sm text-foreground outline-none focus:border-accent disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
