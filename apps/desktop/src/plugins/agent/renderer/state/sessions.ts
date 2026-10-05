import { atom } from 'jotai'
import { agentCap } from '../agent-cap'
import type { Attachment } from '../chat/attachments'
import { sessionsWorthAsking } from '../lib/notices'
import { receivePtyData } from '../lib/session-terminals'
import { activeRemoteAtom, type PluginEventHandler, type PluginStore } from '@/plugin-api'
import { resetTurnReviewAtom, turnReviewOpenAtom } from './turns'

/**
 * The surface the agents are: one page, the chat of one session with every
 * session, finished ones included, as a stack of bubbles beside it. A terminal
 * onto Claude Code stays behind it, never shown unless a dialog needs one,
 * because what is written in the chat is typed into it.
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
  /** Only for 'idle': finished a turn, failed one, or not given one yet. */
  phase?: 'new' | 'done' | 'failed'
  /** How much of its context window is used, 0 to 100, from its status line.
   *  Absent before its first message and after a `/clear`. */
  contextPercent?: number
  /** Epoch milliseconds, when it was started. */
  startedAt?: number
}

/**
 * A session whose process has gone: a line of the agent's history. Mirrors
 * `PastSession` in main/claude/listing.ts, pushed as the agent's `history`
 * event. Its conversation can still be read, and opening a terminal on it
 * picks it up again.
 */
export interface PastSession {
  id: string
  name: string
  phase: 'done' | 'failed'
  startedAt?: number
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

/** Every finished session of the vault, in listing order. */
export const agentHistoryAtom = atom<PastSession[]>([])

/** The chats put in the archive, by job id: out of the stack, in the history. */
export const agentArchivedAtom = atom<string[]>([])

/** One session in the stack: a live one, or a finished one. */
export type StackEntry =
  | { kind: 'live'; id: string; name: string; startedAt: number; session: AgentSession }
  | { kind: 'past'; id: string; name: string; startedAt: number; session: PastSession }

/**
 * Every session the agent has had that is not archived, the most recent
 * first: what the stack of bubbles shows, its top the one started last. One that has no start time
 * (Claude Code did not say) sorts as the oldest. Ties keep listing order, live
 * before finished, so the order never shuffles between reads.
 */
const allEntriesAtom = atom((get): StackEntry[] => {
  const live = get(agentSessionsAtom).map((session): StackEntry => ({
    kind: 'live',
    id: session.id,
    name: session.name,
    startedAt: session.startedAt ?? 0,
    session,
  }))
  const past = get(agentHistoryAtom).map((session): StackEntry => ({
    kind: 'past',
    id: session.id,
    name: session.name,
    startedAt: session.startedAt ?? 0,
    session,
  }))
  return [...live, ...past].sort((x, y) => y.startedAt - x.startedAt)
})

export const agentStackAtom = atom((get): StackEntry[] => {
  const archived = new Set(get(agentArchivedAtom))
  return get(allEntriesAtom).filter((e) => !archived.has(e.id))
})

/** The archived chats, the most recent first: the history page's list. */
export const agentArchiveListAtom = atom((get): StackEntry[] => {
  const archived = new Set(get(agentArchivedAtom))
  return get(allEntriesAtom).filter((e) => archived.has(e.id))
})

/** What the agents page shows: a chat, or the history of archived chats. */
export const agentViewAtom = atom<'chat' | 'history'>('chat')

/** The session whose chat the person opened, by job id. Null is none opened:
 *  the page then shows the most recent. */
export const overviewSelectionAtom = atom<string | null>(null)

/** The session the page shows: the one opened if it is still there, else the
 *  most recent, else none. */
export const shownEntryAtom = atom((get): StackEntry | null => {
  const stack = get(agentStackAtom)
  const picked = get(overviewSelectionAtom)
  // One opened from the history is shown though it is not in the stack.
  return get(allEntriesAtom).find((e) => e.id === picked) ?? stack[0] ?? null
})

/** What is written and not yet sent in each session's chat, by job id: an
 *  ask lands here, as it lands unsent in a terminal's own box. */
export const chatDraftsAtom = atom<Readonly<Record<string, string>>>({})

/** The files attached to each session's unsent message, by job id: the draft
 *  names each by a marker, and keeps its place if the chat is left and come
 *  back to. */
export const chatAttachmentsAtom = atom<Readonly<Record<string, readonly Attachment[]>>>({})

/**
 * The session the app is on: the one whose chat the page shows, while it is
 * live. Null when none is, or the one shown has finished.
 */
export const activeSessionAtom = atom<AgentSession | null>((get) => {
  const shown = get(shownEntryAtom)
  return shown?.kind === 'live' ? shown.session : null
})

/** Claude Code's name for an unnamed session, and Holi's for one. */
export const NEW_SESSION = 'New session'

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
  archive: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) store.set(agentArchivedAtom, payload as string[])
  },
  history: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom))
      store.set(agentHistoryAtom, payload as PastSession[])
  },
  terminals: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) {
      store.set(agentTerminalsAtom, payload as AgentTerminal[])
    }
  },
}

/**
 * The agent while `remote` is the open vault: fill the session, history and
 * terminal lists (the events keep them in step after that), and clear them and
 * the turn review on the way out.
 *
 * Asked fresh for every vault, so a renderer reload pulls the lists again.
 */
export function agentVault(remote: string, store: PluginStore): () => void {
  // An event that lands while the opening question is in flight is NEWER
  // than its answer, and letting the answer win would drop what was just
  // announced. Every event is a new list, so an unchanged one means none came.
  const sessionsAsked = store.get(agentSessionsAtom)
  const historyAsked = store.get(agentHistoryAtom)
  const terminalsAsked = store.get(agentTerminalsAtom)
  const archiveAsked = store.get(agentArchivedAtom)
  void agentCap
    .archived(remote)
    .then((list) => {
      if (store.get(agentArchivedAtom) === archiveAsked) store.set(agentArchivedAtom, list)
    })
    .catch(() => {})
  void agentCap.sessions(remote).then((list) => {
    if (store.get(agentSessionsAtom) === sessionsAsked) store.set(agentSessionsAtom, list)
  })
  // A main older than this window has no history to give: the stack is then
  // the live sessions alone, until Holi is restarted.
  void agentCap
    .history(remote)
    .then((list) => {
      if (store.get(agentHistoryAtom) === historyAsked) store.set(agentHistoryAtom, list)
    })
    .catch(() => {})
  void agentCap.terminals(remote).then((list) => {
    if (store.get(agentTerminalsAtom) === terminalsAsked) store.set(agentTerminalsAtom, list)
  })

  return () => {
    // The lists, the open chat and the turn record are per vault: left as they
    // are, the next vault would show this one's sessions until its own answer
    // came, and the review would ask its git for a range it has never heard of.
    store.set(agentSessionsAtom, [])
    store.set(agentHistoryAtom, [])
    store.set(agentArchivedAtom, [])
    store.set(agentViewAtom, 'chat')
    store.set(agentTerminalsAtom, [])
    store.set(overviewSelectionAtom, null)
    store.set(resetTurnReviewAtom)
    store.set(turnReviewOpenAtom, false)
  }
}
