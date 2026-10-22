import { atom, type WritableAtom } from 'jotai'
import { agentCap } from '../agent-cap'
import { sessionsWorthAsking } from '../lib/notices'
import { receivePtyData } from '../lib/session-terminals'
import { activeRemoteAtom, type PluginEventHandler, type PluginStore } from '@/plugin-api'
import type { PendingQuestion } from '../../shared/questions'
import { agentQuestionsAtom, pendingOpenAtom } from './questions'

/** What an action answers: done, or why not, in words the caller can print. */
export type AgentResult = { ok: true } | { ok: false; message: string }

/**
 * The page a session's chat is shown on, as whichever plugin draws one
 * provides it: today `agent-ui`, which fills `agentPageAtom` while it runs.
 * `open` brings a session's chat forward, from the inbox, a schedule's run or
 * the quick panel's "open in Holi".
 */
export interface AgentPage {
  open: WritableAtom<null, [id: string], Promise<AgentResult>>
}

/**
 * The page there is to land on, or null while no plugin draws one. The agent
 * runs its sessions either way; it only cannot show one.
 */
export const agentPageAtom = atom<AgentPage | null>(null)

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
    `${why} Leaving this vault, or turning the agent off, stops every session in it. ` +
    'What they have already ' +
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
  questions: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) {
      store.set(agentQuestionsAtom, payload as PendingQuestion[])
    }
  },
  // The quick panel's ⏎ on a finished agent: its session, in the main window.
  // Opened by `followPendingOpen` once its vault is the one showing.
  'open-session': ({ remote, payload }, store) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id === 'string') store.set(pendingOpenAtom, { remote, id })
  },
}

/**
 * The agent while `remote` is the open vault: fill the session, history and
 * terminal lists (the events keep them in step after that), and clear them on
 * the way out.
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
  void agentCap
    .history(remote)
    .then((list) => {
      if (store.get(agentHistoryAtom) === historyAsked) store.set(agentHistoryAtom, list)
    })
    .catch(() => {})
  void agentCap.terminals(remote).then((list) => {
    if (store.get(agentTerminalsAtom) === terminalsAsked) store.set(agentTerminalsAtom, list)
  })
  const questionsAsked = store.get(agentQuestionsAtom)
  void agentCap.questions(remote).then((list) => {
    if (store.get(agentQuestionsAtom) === questionsAsked) store.set(agentQuestionsAtom, list)
  })

  return () => {
    store.set(agentQuestionsAtom, [])
    // The lists are per vault: left as they are, the next vault would show
    // this one's sessions until its own answer came.
    store.set(agentSessionsAtom, [])
    store.set(agentHistoryAtom, [])
    store.set(agentArchivedAtom, [])
    store.set(agentTerminalsAtom, [])
  }
}
