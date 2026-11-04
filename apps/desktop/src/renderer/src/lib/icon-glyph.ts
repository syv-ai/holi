import type { ComponentType } from 'react'

/** Anything drawn as an svg that takes a class: a lucide or simple-icons
 *  glyph, or one of Holi's own (`PdfIcon`, a vault app's `AppIcon`). */
export type IconGlyph = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
