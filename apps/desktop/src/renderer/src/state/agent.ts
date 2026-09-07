import { atom } from 'jotai'
import type { ColorMode } from '@/lib/agent-notices'

/** Mirrors AgentStatus in main/agent/agent-manager.ts (pushed on 'agent:status'). */
export interface AgentStatus {
  running: boolean
  /** A turn is open — Claude is mid-edit somewhere in the vault. */
  working: boolean
  /** Synced agent config changed under a live session; restart to pick it up. */
  configStale: boolean
}

export const AGENT_STATUS_IDLE: AgentStatus = {
  running: false,
  working: false,
  configStale: false,
}

export const agentPanelOpenAtom = atom(false)
export const agentStatusAtom = atom<AgentStatus>(AGENT_STATUS_IDLE)

/** The colour mode resolved when the live session spawned, null when none has.
 *  An atom rather than AgentPanel's own state because the footer control (#15)
 *  shows the same restart nudge, and one derivation needs one input. */
export const agentModeAtSpawnAtom = atom<ColorMode | null>(null)

/** A pending reconcile seed: set by the "Ask Claude to reconcile" button, it asks
 *  AgentPanel to (re)start the session with this as its first message, then clears
 *  itself. Null when there is no reconcile in flight. */
export const agentSeedPromptAtom = atom<string | null>(null)
