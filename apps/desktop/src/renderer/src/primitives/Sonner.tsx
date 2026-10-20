/**
 * shadcn's `sonner` (radix-nova), the app's one toast. Changed from upstream:
 *
 * - The mode comes in as `theme` rather than from `next-themes`, which Holi
 *   does not use: the shell passes the mode in force (`state/color-scheme.ts`).
 * - The toast is the one floating surface (docs/ui-system.md): `--popover`
 *   under `--shadow-popover`, which carries the hairline, so no border of its
 *   own, and the menus' `--radius-lg`. Sonner's own motion is left as shipped.
 *
 * Mounted once, in the shell. Features raise a toast with `toast(...)` from
 * here, never from `sonner` directly, so the dependency stays a primitive's.
 */
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner'

function Toaster({ theme = 'system', ...props }: ToasterProps): React.JSX.Element {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'transparent',
          '--border-radius': 'var(--radius-lg)',
          fontFamily: 'var(--font-sans)',
        } as React.CSSProperties
      }
      toastOptions={{ style: { boxShadow: 'var(--shadow-popover)' } }}
      {...props}
    />
  )
}

export { Toaster, toast }
