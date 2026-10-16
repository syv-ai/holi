/**
 * What a tool renderer adds to `ToolView` for the card to draw: nothing the
 * contract needs, so a plain `ToolView` is still a valid answer.
 */
import type { ToolItem, ToolState } from '../../../../../agent/renderer/chat/items'
import type { ToolView } from '../registry'

export interface CardView extends ToolView {
  /** The work goes on though the call has its result: a sub-agent launched in
   *  the background, a monitor. The status dot keeps pulsing. */
  busy?: boolean
  /** A token colour for the glyph, when it carries a status (`text-task-done`). */
  iconClass?: string
}

/** The state a card shows. The item says it, but a value this build does not
 *  know falls back to what the result implies. */
export function stateOf(item: ToolItem): ToolState {
  const state: unknown = item?.state
  if (state === 'pending' || state === 'done' || state === 'error' || state === 'rejected') {
    return state
  }
  const result: unknown = item?.result
  if (result === undefined || result === null) return 'pending'
  return (result as { ok?: unknown }).ok === false ? 'error' : 'done'
}

/** "Ran" once done, "Running" while it goes. */
export function verb(item: ToolItem, working: string, done: string): string {
  return stateOf(item) === 'pending' ? working : done
}
