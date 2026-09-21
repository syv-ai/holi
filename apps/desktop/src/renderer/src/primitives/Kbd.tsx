import { cn } from '@/lib/cn'

/**
 * A key, printed the way it reads on screen: the glyph string `lib/hotkey.ts`
 * binds (`⌘J`, `⌘⇧D`). One chip for the palette's shortcut column and the
 * panel header's tooltip, so a hotkey looks the same wherever it is shown.
 */
export function Kbd({ className, ...props }: React.ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      className={cn('rounded border bg-muted px-1 font-sans text-muted-foreground', className)}
      {...props}
    />
  )
}
