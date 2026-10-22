/**
 * The agent's notifications: what pops up in the top right when an agent has
 * an answer, or needs something from you, and you are not looking at it.
 * Each can be opened (the full chat), dismissed, and, for a permission prompt,
 * answered there and then.
 *
 * Read off the session list's own edges: a session that was working and is now
 * idle has finished a turn (its answer is ready), one that is now waiting on
 * you needs you. Nothing is inferred from a terminal.
 */
import { atom } from 'jotai'
import { agentCap } from '../agent-cap'
import { openCalls } from '../../shared/open-calls'
import { lastAnswer } from '../lib/preview'
import { surfaceActiveAtom, type PluginStore } from '@/plugin-api'
import {
  AGENT_SURFACE,
  agentSessionsAtom,
  agentViewAtom,
  shownEntryAtom,
  type AgentSession,
} from './sessions'

export interface AgentNotice {
  /** One per session and kind: a newer one replaces it. */
  id: string
  sessionId: string
  name: string
  kind: 'answer' | 'needs-you'
  /** Only for `needs-you`: why, as Claude Code says it. */
  waitingFor?: string
  /** An answer that is an error: the turn ended badly. */
  failed?: boolean
  /** What it said, in plain words. */
  preview: string
  /** For a permission prompt: the call it asks to run, as `Bash: ls`, when
   *  its turn has exactly one call open; '' when it cannot be told. */
  tool: string
  /** That call's id, which Allow and Deny name so main can check it is still
   *  the one asked about. Absent when it cannot be told: no keys are offered. */
  call?: string
}

export const agentNoticesAtom = atom<readonly AgentNotice[]>([])

/** The session whose quick chat is open, by job id: the small box a bubble
 *  opens from any page but the agents', for a message and nothing else. */
export const quickChatAtom = atom<string | null>(null)

/** How long an answer's notification stays before it goes by itself. A
 *  question to you does not: it stays until answered or dismissed. */
export const ANSWER_NOTICE_MS = 15_000

export const dismissNoticeAtom = atom(null, (_get, set, id: string): void => {
  set(agentNoticesAtom, (all) => all.filter((n) => n.id !== id))
})

/** Every notification of a session goes: its chat is open now. */
export const clearSessionNoticesAtom = atom(null, (_get, set, sessionId: string): void => {
  set(agentNoticesAtom, (all) => all.filter((n) => n.sessionId !== sessionId))
})

/** The session whose chat the person is looking at: its quick chat open,
 *  or the agents page showing it. Null for none. */
export const watchedSessionAtom = atom((get): string | null => {
  const quick = get(quickChatAtom)
  if (quick !== null) return quick
  if (!get(surfaceActiveAtom(AGENT_SURFACE)) || get(agentViewAtom) !== 'chat') return null
  const shown = get(shownEntryAtom)
  return shown?.kind === 'live' ? shown.id : null
})

/** Whether this session's chat is what the person is looking at. Nothing to
 *  announce then. */
function beingWatched(store: PluginStore, sessionId: string): boolean {
  return store.get(watchedSessionAtom) === sessionId
}

/**
 * Tell main whose chat is showing, now and on every change, while `remote` is
 * the open vault: a session being looked at gets no needs-you banner while
 * Holi has the focus, and the chat left behind lets go of the terminal it
 * typed into. Nothing showing on the way out.
 */
export function reportWatching(remote: string, store: PluginStore): () => void {
  let told: string | null | undefined
  const tell = (): void => {
    const id = store.get(watchedSessionAtom)
    if (id === told) return
    told = id
    void agentCap.watching(remote, { id }).catch(() => {})
  }
  tell()
  const off = store.sub(watchedSessionAtom, tell)
  return () => {
    off()
    if (told !== null) void agentCap.watching(remote, { id: null }).catch(() => {})
  }
}

/**
 * Announce each session's edges while `remote` is the open vault. Returns the
 * stop. The first list is the baseline: what was already running when the
 * vault opened is not news.
 */
export function watchNotices(remote: string, store: PluginStore): () => void {
  let before = new Map<string, AgentSession>(store.get(agentSessionsAtom).map((s) => [s.id, s]))
  let stopped = false

  const add = async (session: AgentSession, kind: AgentNotice['kind']): Promise<void> => {
    // The tail of the conversation says what was answered, and what is asked.
    const chunk = await agentCap.transcript(remote, { id: session.id }).catch(() => null)
    if (stopped) return
    // It may have been looked at, or have moved on, while that was read.
    if (beingWatched(store, session.id)) return
    const now = store.get(agentSessionsAtom).find((s) => s.id === session.id)
    if (now === undefined || (kind === 'needs-you' && now.state !== 'needs-you')) return
    const entries = chunk?.entries ?? []
    const open = kind === 'needs-you' ? openCalls(entries) : []
    const only =
      open.length === 1 ? entries.find((e) => e.kind === 'tool' && e.id === open[0]) : undefined
    const call = only?.kind === 'tool' ? only : null
    const notice: AgentNotice = {
      id: `${session.id}:${kind}`,
      sessionId: session.id,
      name: session.name,
      kind,
      ...(kind === 'needs-you' && session.waitingFor !== undefined
        ? { waitingFor: session.waitingFor }
        : {}),
      ...(kind === 'answer' && session.phase === 'failed' ? { failed: true } : {}),
      preview: kind === 'answer' ? lastAnswer(entries) : '',
      tool: call === null ? '' : call.summary === '' ? call.name : `${call.name}: ${call.summary}`,
      ...(call === null ? {} : { call: call.id }),
    }
    store.set(agentNoticesAtom, (all) => [...all.filter((n) => n.id !== notice.id), notice])
  }

  const off = store.sub(agentSessionsAtom, () => {
    const now = store.get(agentSessionsAtom)
    const nowIds = new Set(now.map((s) => s.id))
    for (const session of now) {
      const was = before.get(session.id)?.state
      if (was === undefined || was === session.state) continue
      if (session.state === 'needs-you') void add(session, 'needs-you')
      // A turn that ended: it was working and is idle, not failed or new.
      else if (was === 'working' && session.state === 'idle' && session.phase !== 'new') {
        void add(session, 'answer')
      }
    }
    before = new Map(now.map((s) => [s.id, s]))
    // No longer waiting, or gone: its question is moot.
    store.set(agentNoticesAtom, (all) => {
      const next = all.filter((n) => {
        const s = now.find((x) => x.id === n.sessionId)
        return nowIds.has(n.sessionId) && (n.kind !== 'needs-you' || s?.state === 'needs-you')
      })
      return next.length === all.length ? all : next
    })
  })

  return () => {
    stopped = true
    off()
    store.set(agentNoticesAtom, [])
    store.set(quickChatAtom, null)
  }
}
