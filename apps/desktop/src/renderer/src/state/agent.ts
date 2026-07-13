import { atom } from 'jotai'

/** Mirrors AgentStatus in main/agent/agent-manager.ts (pushed on 'agent:status'). */
export interface AgentStatus {
  running: boolean
  /** A turn is open — Claude is mid-edit somewhere in the vault. */
  working: boolean
  /** Synced agent config changed under a live session; restart to pick it up. */
  configStale: boolean
  authenticated: boolean
}

export const AGENT_STATUS_IDLE: AgentStatus = {
  running: false,
  working: false,
  configStale: false,
  authenticated: true,
}

export const agentPanelOpenAtom = atom(false)
export const agentStatusAtom = atom<AgentStatus>(AGENT_STATUS_IDLE)
