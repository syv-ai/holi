import type { ReactNode } from 'react'
import type { IconGlyph, IconMotion, IconTone } from '@/primitives'

/** One place the nav offers (`useNavItems`), as the nav menu and the sidebar
 *  draw it. */
export type NavAction = {
  id: string
  label: string
  icon: IconGlyph
  /** A count at the row's end. Nothing when absent or zero. */
  badge?: number
  /** `alert` paints the badge in the destructive colour: something is late. */
  badgeTone?: 'alert'
  /** The glyph's colour for a state. */
  tone?: IconTone
  /** The glyph loops while its state is in flight. */
  motion?: IconMotion
  onSelect?: () => void
  /** A panel of its own instead of an action (sync, update): given `close`,
   *  so the panel can close its menu when its work is done, and whether it
   *  is showing. */
  panel?: (close: () => void, open: boolean) => ReactNode
}

/** One level of children keeps the menu small and the way back predictable. */
export type NavItem = NavAction & { children?: readonly NavAction[] }
