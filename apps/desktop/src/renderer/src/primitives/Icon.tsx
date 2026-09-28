/**
 * The one way a glyph is drawn in the renderer's React tree
 * (`docs/ui-system.md`, Icons).
 *
 * **Size and stroke live here and nowhere else.** Two sizes, `sm` (14px, beside
 * text and in dense controls) and `md` (16px, toolbars, menus, the dock), from
 * the `--icon-*` tokens in `index.css`. The size is a class, never lucide's
 * `width` attribute, so no container rule can quietly override it. The lint
 * gate rejects a lucide or simple-icons glyph rendered anywhere but here.
 *
 * **Colour is the holder's.** An icon inherits `currentColor`: an `IconButton`
 * or a menu row decides how its icon looks at rest and under the pointer. A
 * bare icon beside text takes `tone="muted"`; a signal colour (brand,
 * destructive, a file type, a task status) comes in as a token class.
 */
import type { ComponentType } from 'react'
import { cn } from '@/lib/cn'

/** Anything drawn as an svg that takes a class: a lucide or simple-icons
 *  glyph, or one of Holi's own (`AppIcon`, `PdfIcon`). */
export type IconGlyph = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>

export type IconSize = 'sm' | 'md'

export function Icon({
  icon: Glyph,
  size = 'md',
  tone = 'inherit',
  filled = false,
  className,
}: {
  icon: IconGlyph
  size?: IconSize
  /** `muted` for a decorative icon beside text; `inherit` takes the holder's. */
  tone?: 'inherit' | 'muted'
  /** Fill the outline with the colour too, as a starred item's star. */
  filled?: boolean
  /** Layout, or a token colour for a signal (`text-brand`, `text-task-done`). */
  className?: string
}): React.JSX.Element {
  return (
    <Glyph
      aria-hidden
      className={cn(
        'pointer-events-none shrink-0',
        size === 'sm' ? 'icon-sm' : 'icon-md',
        tone === 'muted' && 'text-icon',
        filled && 'fill-current',
        className,
      )}
    />
  )
}
