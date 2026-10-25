/**
 * The bottom panel (docs/features/status-bar.md), VS Code's Panel: whether it
 * is open, on which tab, how tall, and whether it fills the column.
 *
 * Shell state, not a tab's: it stays as it is while tabs and splits change.
 * The height is this machine's (localStorage); open and tab last the session.
 */
import { atom } from 'jotai'

export type PanelTab = 'terminal' | 'output' | 'logs'

export interface BottomPanelState {
  open: boolean
  tab: PanelTab
  /** It fills the main column, the views folded behind it. */
  maximized: boolean
}

export const bottomPanelAtom = atom<BottomPanelState>({
  open: false,
  tab: 'terminal',
  maximized: false,
})

/**
 * ⌃`, ⇧⌘U and the status bar's two items: open the panel on `tab`, or close
 * it when it is already showing that tab. Another tab showing switches.
 */
export function togglePanel(state: BottomPanelState, tab: PanelTab): BottomPanelState {
  if (state.open && state.tab === tab) return { ...state, open: false, maximized: false }
  return { ...state, open: true, tab }
}

export const togglePanelAtom = atom(null, (get, set, tab: PanelTab) =>
  set(bottomPanelAtom, togglePanel(get(bottomPanelAtom), tab)),
)

/** Open on `tab`, whatever it shows now. */
export const showPanelAtom = atom(null, (get, set, tab: PanelTab) =>
  set(bottomPanelAtom, { ...get(bottomPanelAtom), open: true, tab }),
)

/** The default height, and what a double-click on the edge returns to. */
export const PANEL_DEFAULT_HEIGHT = 280
export const PANEL_MIN_HEIGHT = 120
/** Of the column, so the views keep some room. */
export const PANEL_MAX_SHARE = 0.7

const HEIGHT_KEY = 'holi.bottom-panel.height'

/** A height held to the bounds for a column `available` px tall. */
export function clampPanelHeight(height: number, available: number): number {
  const max = Math.max(PANEL_MIN_HEIGHT, Math.floor(available * PANEL_MAX_SHARE))
  return Math.round(Math.min(max, Math.max(PANEL_MIN_HEIGHT, height)))
}

export function readPanelHeight(): number {
  try {
    const raw = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(raw) && raw >= PANEL_MIN_HEIGHT ? raw : PANEL_DEFAULT_HEIGHT
  } catch {
    return PANEL_DEFAULT_HEIGHT
  }
}

export function writePanelHeight(height: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // Storage off (a private window): the height lasts the session only.
  }
}
