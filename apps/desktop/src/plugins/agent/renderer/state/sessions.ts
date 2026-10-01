import { atom } from 'jotai'
import { agentCap } from '../agent-cap'
import { sessionsWorthAsking } from '../lib/notices'
import { receivePtyData } from '../lib/session-terminals'
import {
  activeRemoteAtom,
  activeSurfaceIdAtom,
  closeSurfaceTabsAtom,
  surfaceTabIdsAtom,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { resetTurnReviewAtom, turnReviewOpenAtom } from './turns'

/**
 * The surface an agent tab is: a terminal onto Claude Code, by the id main
 * minted for it, the agents list or one background session.
 *
 * **Closing the tab does not end a session**: it detaches, the session keeps
 * running, and the sidebar's rows are how you get back to it. What the tab
 * shows can change under it (`←` goes back to the list), so it is named by its
 * terminal, never by a session.
 */
export const AGENT_SURFACE = 'agent'

/** What a session is doing. Claude Code's own answer, read by main. */
export type SessionState = 'needs-you' | 'working' | 'idle'

/**
 * One of the vault's live Claude Code background sessions, by its job id.
 * Mirrors `SessionSummary` in main/claude/listing.ts, pushed as a list
 * in the agent's `sessions` event. Only live ones: a stopped or finished session lives in
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
  /** How much of its context window is used, 0 to 100, from its status line.
   *  Absent before its first message and after a `/clear`. */
  contextPercent?: number
}

/**
 * One of Holi's terminals onto Claude Code. Mirrors `TerminalSummary` in
 * main/host/terminals.ts, pushed in the agent's `terminals` event.
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
 * nothing Claude Code publishes says which. So this is only ever a
 * default for an ask, never an identity.
 */
export const activeSessionAtom = atom<AgentSession | null>((get) => {
  const sessions = get(agentSessionsAtom)
  const terminals = get(agentTerminalsAtom)
  const byId = (id: string | null) =>
    id === null ? null : (sessions.find((s) => s.id === id) ?? null)
  const tabId = get(activeSurfaceIdAtom(AGENT_SURFACE))
  if (tabId !== null) {
    const shown = byId(terminals.find((t) => t.id === tabId)?.launchedFor ?? null)
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
 * Why leaving the vault costs something now: the sessions mid-turn or waiting
 * on you, the same line the sidebar's Stop draws. An idle conversation stops
 * quietly and picks up again from the agents list. A count rather than a list
 * for several: three names in a sentence is a list to read, and the sidebar
 * is already showing them.
 */
export const agentLeaveGuardAtom = atom((get): string | null => {
  const busy = sessionsWorthAsking(get(agentSessionsAtom))
  const one = busy[0]
  if (one === undefined) return null
  const why =
    busy.length > 1
      ? `${busy.length} sessions are still running.`
      : one.state === 'needs-you'
        ? `${one.name} is waiting for you to answer something.`
        : `${one.name} is part way through a turn.`
  return (
    `${why} Leaving this vault stops every session in it. What they have already ` +
    'written stays in it, and each conversation stays in the agents list, where it ' +
    'picks up where it left off.'
  )
})

/**
 * What main tells the agent's renderer side. A terminal's output goes
 * straight to its xterm, never through an atom. A list is about one vault,
 * and one about a vault Holi has since left is stale.
 */
export const agentEvents: Readonly<Record<string, PluginEventHandler>> = {
  'pty-data': ({ payload }) => receivePtyData(payload),
  sessions: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom))
      store.set(agentSessionsAtom, payload as AgentSession[])
  },
  terminals: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) {
      store.set(agentTerminalsAtom, payload as AgentTerminal[])
    }
  },
}

/**
 * The agent while `remote` is the open vault: fill the session and terminal
 * lists (the events keep them in step after that), close the tabs of
 * terminals that have gone, detach a terminal whose last tab closed, and clear
 * the lists and the turn review on the way out.
 *
 * Asked fresh for every vault, so a renderer reload pulls the lists again.
 */
export function agentVault(remote: string, store: PluginStore): () => void {
  // An event that lands while the opening question is in flight is NEWER
  // than its answer, and letting the answer win would drop what was just
  // announced. Every event is a new list, so an unchanged one means none came.
  const sessionsAsked = store.get(agentSessionsAtom)
  const terminalsAsked = store.get(agentTerminalsAtom)
  void agentCap.sessions(remote).then((list) => {
    if (store.get(agentSessionsAtom) === sessionsAsked) store.set(agentSessionsAtom, list)
  })
  void agentCap.terminals(remote).then((list) => {
    if (store.get(agentTerminalsAtom) === terminalsAsked) store.set(agentTerminalsAtom, list)
  })

  // A terminal leaves main's list when its client exits: a detach, `/exit`,
  // or its session stopped. Its tabs go with it.
  const offGone = store.sub(agentTerminalsAtom, () =>
    store.set(
      closeSurfaceTabsAtom,
      AGENT_SURFACE,
      store.get(agentTerminalsAtom).map((t) => t.id),
    ),
  )

  // Closing an agent tab only ends its window (the session keeps running);
  // without a detach the PTY would linger in main's list, which the palette
  // and the reuse paths read. Diffed across each change of the open tabs, so
  // a tab moved between panes is not a close.
  const tabs = surfaceTabIdsAtom(AGENT_SURFACE)
  let open = new Set(store.get(tabs))
  const offTabs = store.sub(tabs, () => {
    const now = new Set(store.get(tabs))
    for (const id of open) if (!now.has(id)) void agentCap.detach(remote, { id })
    open = now
  })

  return () => {
    offGone()
    offTabs()
    // Both lists and the turn record are per vault: left as they are, the
    // next vault would show this one's sessions until its own answer came,
    // and the review would ask its git for a range it has never heard of.
    store.set(agentSessionsAtom, [])
    store.set(agentTerminalsAtom, [])
    store.set(resetTurnReviewAtom)
    store.set(turnReviewOpenAtom, false)
  }
}
