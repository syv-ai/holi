/**
 * One size for every drawer in Holi: the nav, history, the last turn, and the
 * PDF viewer's sidebars. A drawer opens at `default` and is dragged between
 * `min` and `max`; each remembers its own dragged width (`DrawerShell`).
 *
 * Here rather than in the component because the PDF sidebars are the PDF
 * library's own DOM and take their width from its schema
 * (`pdf-viewer-config.ts`), so the number has to reach a stylesheet string as
 * well as a React prop.
 */
export const DRAWER_WIDTH = { default: 320, min: 150, max: 560 } as const

/** A width inside the drawer range, rounded to a whole pixel. */
export function clampDrawerWidth(px: number): number {
  return Math.round(Math.min(DRAWER_WIDTH.max, Math.max(DRAWER_WIDTH.min, px)))
}
