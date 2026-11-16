/**
 * The tab switcher's hold-and-release mechanics (docs/features/tabs-panes.md),
 * as one pure function: ⌃Tab with Control held steps a selection through the
 * strip's entries, letting go of Control opens the one selected, Escape
 * cancels. The view (`tab-switcher.tsx`) feeds it key events and selects the
 * entry it hands back; nothing here knows about React or the DOM.
 *
 * The order is the caller's: the shell hands it the entries most recently
 * used first (`entriesByRecency`), so the first press goes to the tab used
 * before this one.
 */

/** Open: the strip's entries as they were on the first press, and which one
 *  is selected. `pinned`: opened by a click, not by a held Control, so
 *  letting go of Control opens nothing and the list stays until a row is
 *  chosen (or Enter) or it is dismissed. Closed: null. */
export type TabSwitch = { order: readonly string[]; at: number; pinned?: boolean } | null

export type TabSwitchEvent =
  /** ⌃Tab (1) or ⌃⇧Tab (-1), over `order` (most recently used first). `held` says Control is still down: run from
   *  the shortcuts list or the menu it is not, and the step lands at once. */
  | {
      kind: 'step'
      step: 1 | -1
      held: boolean
      order: readonly string[]
      active: string | null
    }
  /** Control let go. `order` is the strip as it is now: an entry closed
   *  while switching opens nothing. */
  | { kind: 'release'; order: readonly string[] }
  /** The strip's tab count clicked: the list opens pinned, with the entry
   *  used before this one selected, as a first ⌃Tab would. */
  | { kind: 'open'; order: readonly string[]; active: string | null }
  /** Enter on a pinned list: open the entry selected, against the strip as
   *  it is now. */
  | { kind: 'commit'; order: readonly string[] }
  /** Escape, a click outside, or the window losing focus. */
  | { kind: 'cancel' }
  /** A row clicked, against the strip as it is now. */
  | { kind: 'choose'; id: string; order: readonly string[] }

export interface TabSwitchResult {
  state: TabSwitch
  /** The entry to select now, if any. */
  select?: string
}

export function tabSwitch(state: TabSwitch, event: TabSwitchEvent): TabSwitchResult {
  switch (event.kind) {
    case 'step': {
      if (state !== null) {
        const n = state.order.length
        return { state: { ...state, at: (state.at + event.step + n) % n } }
      }
      const { order, active, step } = event
      const n = order.length
      if (n === 0) return { state: null }
      const current = active === null ? -1 : order.indexOf(active)
      const from = current < 0 ? (step > 0 ? -1 : 0) : current
      const at = (from + step + n) % n
      if (at === current) return { state: null }
      if (!event.held) return { state: null, select: order[at]! }
      return { state: { order, at } }
    }
    case 'release':
      return state === null || state.pinned === true
        ? { state }
        : still(event.order, state.order[state.at]!)
    case 'open': {
      const { order, active } = event
      if (order.length === 0) return { state: null }
      const current = active === null ? -1 : order.indexOf(active)
      return { state: { order, at: (current + 1) % order.length, pinned: true } }
    }
    case 'commit':
      return state === null ? { state } : still(event.order, state.order[state.at]!)
    case 'cancel':
      return { state: null }
    case 'choose':
      return still(event.order, event.id)
  }
}

/** Closed, selecting `id` if the strip still holds it. */
function still(order: readonly string[], id: string): TabSwitchResult {
  return order.includes(id) ? { state: null, select: id } : { state: null }
}
