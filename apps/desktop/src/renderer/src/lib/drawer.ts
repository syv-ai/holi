/**
 * One size for every drawer in Holi: the nav, history, the last turn, and the
 * PDF viewer's sidebars. A drawer opens at `default` and is dragged between
 * `min` and `max`; each remembers its own dragged width (`DrawerShell`).
 *
 * Not in the component: the PDF sidebars take their width from the library's
 * schema (`pdf-viewer-config.ts`), so it must reach a stylesheet string too.
 */
export const DRAWER_WIDTH = { default: 320, min: 150, max: 560 } as const

/** A width inside the drawer range, rounded to a whole pixel. */
export function clampDrawerWidth(px: number): number {
  return Math.round(Math.min(DRAWER_WIDTH.max, Math.max(DRAWER_WIDTH.min, px)))
}
