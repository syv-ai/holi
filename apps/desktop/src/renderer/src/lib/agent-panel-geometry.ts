/** ~80 terminal columns at fontSize 13 — below this the CLI's own UI wraps. */
export const MIN_AGENT_PANEL_WIDTH = 660

/** The editor stays usable no matter how far the drawer is dragged open. */
export const MIN_EDITOR_WIDTH = 480

export const DEFAULT_AGENT_PANEL_WIDTH = 720

/** Clamp a dragged width to [MIN_AGENT_PANEL_WIDTH, viewport - MIN_EDITOR_WIDTH].
 * On a viewport too narrow for both, the panel's minimum wins — a terminal that
 * doesn't wrap beats an editor with elbow room. */
export function clampPanelWidth(next: number, viewport: number): number {
  const max = Math.max(MIN_AGENT_PANEL_WIDTH, viewport - MIN_EDITOR_WIDTH)
  return Math.round(Math.min(max, Math.max(MIN_AGENT_PANEL_WIDTH, next)))
}
