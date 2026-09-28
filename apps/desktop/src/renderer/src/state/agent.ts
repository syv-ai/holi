import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { activeTab, closeAgentTabs, workspaceAtom } from './panes'
import { resetTurnReviewAtom, turnReviewOpenAtom } from './turns'

/** What a session is doing. Claude Code's own answer, read by main (D110). */
export type SessionState = 'needs-you' | 'working' | 'idle'

/**
 * One of the vault's live Claude Code background sessions, by its job id.
 * Mirrors `SessionSummary` in main/agent/claude-sessions.ts, pushed as a list
 * on `agent:sessions`. Only live ones: a stopped or finished session lives in
 * Claude Code's own agent list.
 */
export interface AgentSession {
  id: string
  /** Claude Code's name for it (`--name`, `/rename`, Ctrl+R, or the one it
   *  writes itself), else 'New session'. */
  name: string
  state: SessionState
  /** Only for 'needs-you': why, e.g. 'permission prompt'. */
  waitingFor?: string
}

/**
 * One of Holi's terminals onto Claude Code. Mirrors `TerminalSummary` in
 * main/agent/agent-terminals.ts, pushed on `agent:terminals`.
 */
export interface AgentTerminal {
  id: string
  /** The session Holi opened it for, or null for the agents list. What it
   *  shows now may differ: `←` inside a session goes back to the list. */
  launchedFor: string | null
  /** The title its program set; '' until it sets one. */
  title: string
}

/** The vault's live sessions, in Claude Code's order. */
export const agentSessionsAtom = atom<AgentSession[]>([])

/** Holi's open terminals, in the order they were opened. */
export const agentTerminalsAtom = atom<AgentTerminal[]>([])

/** The terminal behind an agent tab, if it is still open. */
export const agentTerminalAtom = (id: string) =>
  atom((get) => get(agentTerminalsAtom).find((t) => t.id === id) ?? null)

/**
 * The session the app is on: the one the active tab was opened for, while it
 * is live. Otherwise the one behind the most recently opened terminal that was
 * opened for a live session. Null when neither says.
 *
 * A guess by construction: an agents tab can be attached to any session, and
 * nothing Claude Code publishes says which (D110). So this is only ever a
 * default for an ask, never an identity.
 */
export const activeSessionAtom = atom<AgentSession | null>((get) => {
  const sessions = get(agentSessionsAtom)
  const terminals = get(agentTerminalsAtom)
  const byId = (id: string | null) =>
    id === null ? null : (sessions.find((s) => s.id === id) ?? null)
  const tab = activeTab(get(workspaceAtom))
  if (tab?.kind === 'agent') {
    const shown = byId(terminals.find((t) => t.id === tab.id)?.launchedFor ?? null)
    if (shown !== null) return shown
  }
  for (const t of [...terminals].reverse()) {
    const s = byId(t.launchedFor)
    if (s !== null) return s
  }
  return null
})

/** Claude Code's name for an unnamed session, and Holi's for one. */
export const NEW_SESSION = 'New session'

/** A terminal's title less the state glyph Claude Code puts in front of it. */
export const titleText = (terminal: AgentTerminal): string =>
  terminal.title.replace(/^[^\p{L}\p{N}]+\s+/u, '').trim()

/** Claude Code titles its list `… claude agents`. */
export const titleIsList = (terminal: AgentTerminal): boolean =>
  /\bclaude agents$/.test(titleText(terminal))

/**
 * The live session a terminal's title names, if exactly one has that name.
 * Claude Code titles an attached session by its name, so only a named one can
 * be found this way: an unnamed session's title is generic ("current
 * session", "Claude Code").
 */
export function sessionTitled(
  terminal: AgentTerminal,
  sessions: AgentSession[],
): AgentSession | null {
  const title = titleText(terminal)
  if (title === '' || title === NEW_SESSION) return null
  // Names are not unique: a name two sessions share names neither.
  const named = sessions.filter((s) => s.name === title)
  return named.length === 1 ? named[0]! : null
}

/**
 * What an agent tab is called, in Holi's names so a tab and its sidebar row
 * agree: the session its title names, "Agents" for the list, and "New
 * session" for a session Claude Code has not named, whatever generic title it
 * gave that. A terminal that has not titled itself yet is what Holi opened it
 * for.
 */
export function terminalLabel(terminal: AgentTerminal | null, sessions: AgentSession[]): string {
  if (terminal === null) return 'Agents'
  if (titleText(terminal) === '') {
    if (terminal.launchedFor === null) return 'Agents'
    return sessions.find((s) => s.id === terminal.launchedFor)?.name ?? NEW_SESSION
  }
  if (titleIsList(terminal)) return 'Agents'
  return sessionTitled(terminal, sessions)?.name ?? NEW_SESSION
}

/** Where an ask goes: one of the vault's sessions, by id, or a new one. */
export type AgentTarget = string | 'new'

/**
 * The sessions an ask may be sent to, in listing order.
 *
 * Not blocked on a question of their own: text sent to a session sitting on a
 * permission prompt waits behind that prompt at best.
 */
export const askTargetsAtom = atom((get) =>
  get(agentSessionsAtom)
    .filter((s) => s.state !== 'needs-you')
    .map((s) => ({ id: s.id, name: s.name })),
)

/**
 * The target an ask goes to when nobody picked one: the current session, unless
 * there is none or it is waiting on a question of its own, in which case a new
 * one.
 */
export const defaultAgentTargetAtom = atom<AgentTarget>((get) => {
  const active = get(activeSessionAtom)
  if (active === null || active.state === 'needs-you') return 'new'
  return active.id
})

/** What a terminal is opened at before any tab has been measured. xterm's own
 *  native default, so the first paint is never a resize-to-catch-up. */
const FALLBACK_GEOMETRY = { cols: 80, rows: 24 }

/**
 * The geometry the last visible terminal measured. Shared rather than per tab:
 * a terminal opened for an ask has never been shown, so its size is a guess
 * that the terminal refits the moment it is.
 */
export const agentGeometryAtom = atom(FALLBACK_GEOMETRY)

/**
 * Keep the session and terminal lists in step with main, for as long as the
 * app is open.
 *
 * **Mounted by the app shell**, not by whichever view happens to read them: the
 * sidebar's rows and the nav's agent item have to be right before any agent
 * tab exists.
 */
export function useAgentSessions(): void {
  const setSessions = useSetAtom(agentSessionsAtom)
  const setTerminals = useSetAtom(agentTerminalsAtom)

  useEffect(() => {
    // A push that lands while the mount-time question is in flight is NEWER
    // than its answer, and letting the answer win would drop what was just
    // announced.
    let pushedSessions = false
    let pushedTerminals = false
    const offSessions = window.holi.agent.onSessions((list) => {
      pushedSessions = true
      setSessions(list)
    })
    const offTerminals = window.holi.agent.onTerminals((list) => {
      pushedTerminals = true
      setTerminals(list)
    })
    void window.holi.agent.sessions().then((list) => {
      if (!pushedSessions) setSessions(list)
    })
    void window.holi.agent.terminals().then((list) => {
      if (!pushedTerminals) setTerminals(list)
    })
    return () => {
      offSessions()
      offTerminals()
    }
  }, [setSessions, setTerminals])
}

/**
 * Close the tabs of terminals that have gone, and clear the turn review on a
 * vault switch.
 *
 * Both are about the SET rather than any one terminal, so they live in the shell
 * rather than in a tab that may not be open when they need to happen.
 */
export function useAgentTabs(activeRemote: string | null): void {
  const terminals = useAtomValue(agentTerminalsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const resetTurnReview = useSetAtom(resetTurnReviewAtom)
  const setTurnReviewOpen = useSetAtom(turnReviewOpenAtom)

  const ids = terminals.map((t) => t.id).join('\u0000')
  useEffect(() => {
    const live = ids === '' ? [] : ids.split('\u0000')
    setWorkspace((w) => closeAgentTabs(w, live))
  }, [ids, setWorkspace])

  /**
   * A vault switch clears the turn review.
   *
   * The record is per vault, so without this the review stays open on the
   * previous vault's turn, and every query it makes asks the NEW vault's git
   * for a range it has never heard of.
   *
   * The edge and not the level: on mount there is nothing to clear, and clearing
   * anyway would throw away a record that has just been loaded.
   */
  const lastRemote = useRef(activeRemote)
  useEffect(() => {
    if (lastRemote.current === activeRemote) return
    lastRemote.current = activeRemote
    resetTurnReview()
    setTurnReviewOpen(false)
  }, [activeRemote, resetTurnReview, setTurnReviewOpen])
}
