/**
 * What the agents page shows: which session's chat, or the history of
 * archived chats; the stack of bubbles; and what is written and not yet sent
 * in each chat. The page's own, not the agent's: the agent says which
 * sessions there are, and this says which one you are looking at.
 */
import { atom } from 'jotai'
import type { PluginStore } from '@/plugin-api'
import {
  agentArchivedAtom,
  agentHistoryAtom,
  agentSessionsAtom,
  type AgentSession,
  type AgentTarget,
  type Attachment,
  type PastSession,
} from '../../../agent/renderer/public'

/**
 * The surface the agents are: one page, the chat of one session with every
 * session, finished ones included, as a stack of bubbles beside it. A terminal
 * onto Claude Code stays behind it, never shown unless a dialog needs one,
 * because what is written in the chat is typed into it.
 */
export const AGENT_SURFACE = 'agent'

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

/** Leaving a vault: the page opens the next one on its chat, none picked, and
 *  nothing written for this one's sessions is kept for it. */
export function pageVault(store: PluginStore): void {
  store.set(agentViewAtom, 'chat')
  store.set(overviewSelectionAtom, null)
}
