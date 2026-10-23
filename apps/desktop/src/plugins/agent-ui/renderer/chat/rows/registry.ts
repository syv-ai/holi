/**
 * How a conversation's items are drawn (docs/features/agent-sessions.md, The
 * chat): a tool by name through a registry with a generic fallback, every
 * other kind by its own row, every row inside a boundary that shows the raw
 * item when drawing it throws. TO BE WRITTEN beside this file.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ChatContext, ToolItem } from '../../../../agent/renderer/public'

/** What a tool renderer decides about its card; `ToolCard` draws the shell
 *  (the status dot, the chevron, the open/close motion). */
export interface ToolView {
  /** The verb, in the past tense once done: "Ran", "Edited". */
  label: string
  icon: LucideIcon
  /** The one line next to it. */
  summary: string
  /** Small facts after the summary: "+12 −3", "exit 1", "2.3s". */
  chips?: readonly string[]
  /** The expanded content. Null: nothing to expand. */
  body: ReactNode | null
  /** Open from the start (a plan, a failed command), or collapsed. */
  defaultOpen?: boolean
}

/** A renderer returns null when the item is not shaped as it expects (a field
 *  of another type, a result it cannot read): the card then falls back to the
 *  generic view, which shows the raw input and result. It must not throw, but
 *  the boundary catches it if it does. */
export type ToolRenderer = (item: ToolItem, ctx: ChatContext) => ToolView | null
