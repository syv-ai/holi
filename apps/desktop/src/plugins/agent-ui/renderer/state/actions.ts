/**
 * What the page does with a session: bring its chat forward, start one and
 * show it, put an ask in its chat as a draft. The agent's verbs do the work
 * (`startAtom`, `duplicateAtom`); this says where the session lands.
 *
 * **Every session lands through `land`**: the page comes forward showing its
 * chat.
 */
import { atom, type Setter } from 'jotai'
import {
  agentSessionsAtom,
  duplicateAtom,
  startAtom,
  type AgentPage,
  type AgentResult,
  type AgentTarget,
} from '../../../agent/renderer/public'
import { openSurfaceAtom } from '@/plugin-api'
import { agentNoticesAtom, quickChatAtom } from './notices'
import { AGENT_SURFACE, agentViewAtom, chatDraftsAtom, overviewSelectionAtom } from './page'

/** Bring the page forward, showing one session's chat. */
function land(set: Setter, sessionId: string): void {
  set(overviewSelectionAtom, sessionId)
  set(agentViewAtom, 'chat')
  // Read in full now: nothing left to announce, and no smaller chat to keep.
  set(agentNoticesAtom, (all) => all.filter((n) => n.sessionId !== sessionId))
  set(quickChatAtom, null)
  set(openSurfaceAtom, AGENT_SURFACE)
}

/** ⌘J and the agent icon: the agents page, as it was left. */
export const showAgentsAtom = atom(null, (_get, set): Promise<AgentResult> => {
  set(openSurfaceAtom, AGENT_SURFACE)
  return Promise.resolve({ ok: true })
})

/** The history of archived chats, on the agents page. */
export const showHistoryAtom = atom(null, (_get, set): void => {
  set(agentViewAtom, 'history')
  set(openSurfaceAtom, AGENT_SURFACE)
})

/**
 * One session, from a bubble, the palette, the history or the agent's own
 * surfaces (through `agentPageAtom`): its chat on the agents page. A chat is
 * read from the transcript and needs no terminal, so neither a live session
 * nor a finished one opens anything here.
 */
export const showSessionAtom = atom(null, (_get, set, id: string): Promise<AgentResult> => {
  land(set, id)
  return Promise.resolve({ ok: true })
})

/** What this plugin puts in the agent's page slot while it runs. */
export const AGENT_PAGE: AgentPage = { open: showSessionAtom }

/** Why the last session could not start, for the agents page to say. */
export const startErrorAtom = atom<string | null>(null)

/**
 * A new background session and its chat. With a `prompt` that prompt is its
 * first turn (reconcile, a stuck push); without one it waits for yours. With
 * `quick` it opens as the smaller chat over the current page instead of
 * bringing the agents page forward.
 */
export const startSessionAtom = atom(
  null,
  async (
    _get,
    set,
    { quick = false, ...opts }: { name?: string; prompt?: string; quick?: boolean } = {},
  ): Promise<AgentResult> => {
    set(startErrorAtom, null)
    const res = await set(startAtom, opts)
    if (!res.ok) {
      // Said where the person is looking: the agents page, which shows it.
      set(startErrorAtom, res.message)
      set(agentViewAtom, 'chat')
      set(openSurfaceAtom, AGENT_SURFACE)
      return res
    }
    if (quick) set(quickChatAtom, res.sessionId)
    else land(set, res.sessionId)
    return { ok: true }
  },
)

/**
 * Send text to a session, live or new. It lands in that session's chat as an
 * unsent **draft**, and its chat comes forward.
 *
 * One rule for every sender: nothing Holi writes can append a submit to a
 * half-typed draft. A `'new'` target starts a session named from the ask's
 * first line.
 *
 * A target that ended between being picked and being sent to is **refused**,
 * not silently dropped, so the caller can keep the text.
 */
export const sendToAgentAtom = atom(
  null,
  async (get, set, args: { text: string; target: AgentTarget }): Promise<AgentResult> => {
    let id = args.target
    if (id === 'new') {
      // The CLI makes a name of the text's first line.
      const started = await set(startAtom, { name: args.text })
      if (!started.ok) return started
      id = started.sessionId
    } else if (!get(agentSessionsAtom).some((s) => s.id === id)) {
      return { ok: false, message: 'That session has ended. Pick another one.' }
    }
    const drafts = get(chatDraftsAtom)
    const before = drafts[id] ?? ''
    set(chatDraftsAtom, {
      ...drafts,
      [id]: before === '' ? args.text : `${before}\n\n${args.text}`,
    })
    land(set, id)
    return { ok: true }
  },
)

/** Copy a session's conversation into a background session of its own, and
 *  open it. */
export const duplicateSessionAtom = atom(
  null,
  async (_get, set, id: string): Promise<AgentResult> => {
    const res = await set(duplicateAtom, id)
    if (!res.ok) return res
    land(set, res.sessionId)
    return { ok: true }
  },
)
