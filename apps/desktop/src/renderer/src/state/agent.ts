import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ColorMode } from '@/lib/agent-notices'

/** What a session is doing. Claude Code's own answer, joined by main (D100). */
export type SessionState = 'needs-you' | 'working' | 'idle'

/** One of the vault's agent sessions. Mirrors `SessionSummary` in
 *  main/agent/agent-manager.ts, pushed as a list on `agent:sessions`. */
export interface AgentSession {
  id: string
  /** Claude Code's own name for it, or 'New session' when it has none. There is
   *  no rename here: the name is set with `--name` at spawn or `/name` inside. */
  name: string
  state: SessionState
  /** Only for 'needs-you': why, e.g. 'permission prompt'. */
  waitingFor?: string
  configStale: boolean
  /** Its PTY is gone. The tab stays, with its scrollback, until it is closed. */
  exited: boolean
}

export const agentPanelOpenAtom = atom(false)

/** Every session of the open vault, in spawn order, which is tab order. */
export const agentSessionsAtom = atom<AgentSession[]>([])

/** The tab the user picked, or null before they picked one. Not the answer to
 *  "which tab is showing" — `activeSessionAtom` is, because a picked session can
 *  be closed out from under this. */
export const activeSessionIdAtom = atom<string | null>(null)

/**
 * The session the drawer is showing.
 *
 * The pick while it is still in the list, then the first live one, then the
 * first one at all — so closing the active tab lands on a neighbour rather than
 * on nothing, and a list of only exited sessions still shows one.
 */
export const activeSessionAtom = atom<AgentSession | null>((get) => {
  const sessions = get(agentSessionsAtom)
  const picked = sessions.find((s) => s.id === get(activeSessionIdAtom))
  return picked ?? sessions.find((s) => !s.exited) ?? sessions[0] ?? null
})

/**
 * The colour mode resolved when each session spawned, keyed by session id.
 *
 * Per session, not per vault: Holi stamps the mode into the vault's Claude Code
 * config at every spawn (D86) and Claude reads settings at start, so two
 * sessions spawned either side of a theme flip really are on different themes
 * and only one of them needs restarting.
 */
export const agentModeAtSpawnAtom = atom<Record<string, ColorMode>>({})

/**
 * Is the sidebar's Sessions section expanded?
 *
 * Persisted and global rather than per vault, like the apps section's: it is a
 * statement about how you like the sidebar, not about this vault's contents.
 */
export const agentSessionsSectionOpenAtom = atomWithStorage<boolean>(
  'holi:agentSessionsSectionOpen',
  true,
)

/** Where an ask goes: one of the vault's sessions, by id, or a new one. */
export type AgentTarget = string | 'new'

/**
 * The target an ask goes to when nobody picked one.
 *
 * The tab you are looking at, which is the session you are already having this
 * conversation with — unless it has ended or is waiting on a question of its
 * own, in which case the text would sit unread behind that question and a new
 * session is the honest answer.
 */
export const defaultAgentTargetAtom = atom<AgentTarget>((get) => {
  const active = get(activeSessionAtom)
  if (active === null || active.exited || active.state === 'needs-you') return 'new'
  return active.id
})

/** What a session is spawned at before any tab has been measured. xterm's own
 *  native default, so the first paint is never a resize-to-catch-up. */
const FALLBACK_GEOMETRY = { cols: 80, rows: 24 }

/**
 * The geometry the last visible tab measured.
 *
 * Shared rather than per tab: a session started for an ask has never been shown,
 * so it has no geometry of its own, and the drawer is one width for all of them.
 */
export const agentGeometryAtom = atom(FALLBACK_GEOMETRY)
