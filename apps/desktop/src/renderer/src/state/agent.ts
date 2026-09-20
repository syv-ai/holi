import { atom, useAtomValue, useSetAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { useEffect, useRef } from 'react'
import type { ColorMode } from '@/lib/agent-notices'
import { activeTab, closeSessionTabs, workspaceAtom } from './panes'
import { resetTurnReviewAtom, turnReviewOpenAtom } from './turns'

/** What a session is doing. Claude Code's own answer, joined by main (D100). */
export type SessionState = 'needs-you' | 'working' | 'idle'

/** One of the vault's agent sessions. Mirrors `SessionSummary` in
 *  main/agent/agent-manager.ts, pushed as a list on `agent:sessions`. */
export interface AgentSession {
  id: string
  /** Claude Code's own name for it, or 'New session' when it has none. There is
   *  no second name here: it is set with `--name` at spawn or `/rename` inside. */
  name: string
  state: SessionState
  /** Only for 'needs-you': why, e.g. 'permission prompt'. */
  waitingFor?: string
  configStale: boolean
  /** Its PTY is gone. The tab stays, with its scrollback, until it is closed. */
  exited: boolean
}

/** Every session of the open vault, in spawn order. */
export const agentSessionsAtom = atom<AgentSession[]>([])

/** The last session the user opened or picked. A fallback, not the answer:
 *  `activeSessionAtom` asks the workspace first. */
export const activeSessionIdAtom = atom<string | null>(null)

/**
 * The session the app is currently on.
 *
 * **The tab you are looking at is the answer** when it is a session tab (D101),
 * because that is what "currently on" means once a session is an ordinary tab:
 * clicking one in the strip has to move the app's idea of which session you are
 * talking to, and the strip does not know this atom exists.
 *
 * Otherwise the last one picked, then the first live one, then the first at all
 * — so closing a session's tab still leaves an answer, and a vault whose
 * sessions have all exited still has one to show.
 */
export const activeSessionAtom = atom<AgentSession | null>((get) => {
  const sessions = get(agentSessionsAtom)
  const tab = activeTab(get(workspaceAtom))
  if (tab?.kind === 'session') {
    const shown = sessions.find((s) => s.id === tab.id)
    if (shown !== undefined) return shown
  }
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
 * The sessions an ask may be sent to, in tab order.
 *
 * Live, and not blocked on a question of their own: text sent to a session
 * sitting on a permission prompt waits behind that prompt at best, so offering
 * it is offering somewhere for an ask to disappear to.
 */
export const askTargetsAtom = atom((get) =>
  get(agentSessionsAtom)
    .filter((s) => !s.exited && s.state !== 'needs-you')
    .map((s) => ({ id: s.id, name: s.name })),
)

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
 * so it has no geometry of its own, and something has to be guessed for it. The
 * last measurement is the best guess available — panes can be different widths
 * (D101), so it may be the wrong one, and the terminal refits the moment it is
 * shown either way.
 */
export const agentGeometryAtom = atom(FALLBACK_GEOMETRY)

/**
 * Keep the session list in step with main, for as long as the app is open.
 *
 * **Mounted by the app shell**, not by whichever view happens to read the list:
 * the footer's dot has to be right before any session tab exists, and the list
 * is how the sidebar knows to show its section at all. A subscription that lived
 * in a tab would start when you opened one, which is exactly when it is already
 * too late. This used to live in the drawer, which was always mounted for the
 * same reason and is gone (D101).
 */
export function useAgentSessions(): void {
  const setSessions = useSetAtom(agentSessionsAtom)
  const setModeAtSpawn = useSetAtom(agentModeAtSpawnAtom)
  const sessions = useAtomValue(agentSessionsAtom)

  useEffect(() => {
    // A push that lands while the mount-time question is in flight is NEWER than
    // its answer, and letting the answer win would drop a session that has just
    // been announced.
    let pushed = false
    const off = window.holi.agent.onSessions((list) => {
      pushed = true
      setSessions(list)
    })
    void window.holi.agent.sessions().then((list) => {
      if (!pushed) setSessions(list)
    })
    return off
  }, [setSessions])

  /** A session that has left the list takes its spawn-time colour mode with it.
   *  The map is keyed by session id and nothing else prunes it. */
  useEffect(() => {
    setModeAtSpawn((byId) => {
      const live = new Set(sessions.map((s) => s.id))
      const kept = Object.entries(byId).filter(([id]) => live.has(id))
      // Same object when nothing went, so this cannot loop on its own write.
      return kept.length === Object.keys(byId).length ? byId : Object.fromEntries(kept)
    })
  }, [sessions, setModeAtSpawn])
}

/**
 * Close the tabs of sessions that have gone, and clear the turn review on a
 * vault switch.
 *
 * Both were the drawer's, and both are about the SET rather than about any one
 * session, so they move to the shell with the subscription above rather than
 * into a tab that may not be open when they need to happen.
 */
export function useSessionTabs(activeRemote: string | null): void {
  const sessions = useAtomValue(agentSessionsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const resetTurnReview = useSetAtom(resetTurnReviewAtom)
  const setTurnReviewOpen = useSetAtom(turnReviewOpenAtom)

  const ids = sessions.map((s) => s.id).join('\u0000')
  useEffect(() => {
    const live = ids === '' ? [] : ids.split('\u0000')
    setWorkspace((w) => closeSessionTabs(w, live))
  }, [ids, setWorkspace])

  /**
   * A vault switch clears the turn review.
   *
   * The record is per vault, so without this the review stays open on the
   * previous vault's turn — and every query it makes asks the NEW vault's git
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
