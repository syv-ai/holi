/**
 * The chat plugin's capabilities, as the renderer calls them
 * (`main/capabilities.ts`), and the slice of the agent's it calls for a turn's
 * review: typed here, because a plugin never imports another.
 */
import { capClient, type UiCapability } from '@/plugin-api'
import type { chatCapabilities } from '../main/capabilities'

export const chatCap = capClient<ReturnType<typeof chatCapabilities>>('chats')

/** One recorded turn: the commit range it changed, under its session's id. */
export interface Turn {
  base: string
  end: string
  at: string
  sessionId?: string
}

export interface TurnFile {
  path: string
  added: number
  removed: number
  /** `A` | `M` | `D` | `R<score>`. */
  status: string
}

export const agentTurnsCap = capClient<{
  'agent.turns': UiCapability<Record<string, never>, Turn[]>
  'agent.turnFiles': UiCapability<{ base: string; end: string }, TurnFile[]>
  'agent.turnDiff': UiCapability<
    { base: string; end: string; path: string },
    { before: string; after: string }
  >
  'agent.revert': UiCapability<
    { path: string; text: string } | { path: string; delete: true },
    { ok: true }
  >
}>('agent')
