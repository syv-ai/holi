/**
 * What you *do* to the vault's assistant: open the agents, open a session,
 * start one, send one an ask, stop, restart or copy it.
 *
 * Separate from `state/agent.ts` (what the assistant *is*) because these need
 * the terminal geometry and the workspace, and a third module keeps
 * `agent.ts` free of both.
 *
 * **Every session lands through `land`**: the page comes forward showing its
 * chat.
 */
import { atom, type Getter, type Setter } from 'jotai'
import { agentCap } from '../agent-cap'
import { typeIntoTerminal } from '../lib/session-terminals'
import {
  AGENT_SURFACE,
  agentGeometryAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  chatDraftsAtom,
  agentViewAtom,
  overviewSelectionAtom,
  type AgentTarget,
} from './sessions'
import { activeRemoteAtom, openSurfaceAtom } from '@/plugin-api'
import { agentNoticesAtom, quickChatAtom } from './notices'

/** What an action answers: done, or why not, in words the caller can print. */
export type AgentResult = { ok: true } | { ok: false; message: string }

/** Bring the page forward, showing one session's chat. */
function land(set: Setter, sessionId: string): void {
  set(overviewSelectionAtom, sessionId)
  set(agentViewAtom, 'chat')
  // Read in full now: nothing left to announce, and no smaller chat to keep.
  set(agentNoticesAtom, (all) => all.filter((n) => n.sessionId !== sessionId))
  set(quickChatAtom, null)
  set(openSurfaceAtom, AGENT_SURFACE)
}

const geometry = (get: Getter) => get(agentGeometryAtom)

const NO_VAULT = { ok: false as const, message: 'No vault is open.' }

/** Run `call` against the open vault, or answer that there is none. */
function inVault<R>(
  get: Getter,
  call: (remote: string) => Promise<R>,
): Promise<R | typeof NO_VAULT> {
  const remote = get(activeRemoteAtom)
  return remote === null ? Promise.resolve(NO_VAULT) : call(remote)
}

/**
 * ⌘J and the agent icon: the agents page, as it was left.
 */
export const showAgentsAtom = atom(null, (_get, set): Promise<AgentResult> => {
  set(openSurfaceAtom, AGENT_SURFACE)
  return Promise.resolve({ ok: true })
})

/** The history of archived chats, on the agents page. */
export const showHistoryAtom = atom(null, (_get, set): void => {
  set(agentViewAtom, 'history')
  set(openSurfaceAtom, AGENT_SURFACE)
})

/** Put a chat in the archive, or take it out. A live session is stopped by
 *  the caller first: archiving never leaves one running out of sight. */
export const archiveSessionAtom = atom(
  null,
  (get, _set, args: { id: string; archived: boolean }): Promise<AgentResult> =>
    inVault(get, (remote) => agentCap.archive(remote, args)).then(
      (res) => res,
      (err: unknown) => ({ ok: false as const, message: failure(err) }),
    ),
)

/** Delete a finished chat for good. */
export const removeSessionAtom = atom(null, (get, _set, id: string): Promise<AgentResult> =>
  inVault(get, (remote) => agentCap.remove(remote, { id })).then(
    (res) => res,
    (err: unknown) => ({ ok: false as const, message: failure(err) }),
  ),
)

/**
 * One session, from a bubble, the palette or the history: its chat
 * on the agents page. A chat is read from the transcript and needs no
 * terminal, so neither a live session nor a finished one opens anything here.
 */
export const openSessionAtom = atom(null, (_get, set, id: string): Promise<AgentResult> => {
  land(set, id)
  return Promise.resolve({ ok: true })
})

/**
 * A new background session and its window. With a `prompt` that prompt is its
 * first turn (reconcile, a stuck push); without one it waits for yours. With
 * `quick` it opens as the smaller chat over the current page instead of
 * bringing the agents page forward.
 */
export const startSessionAtom = atom(
  null,
  async (
    get,
    set,
    { quick = false, ...opts }: { name?: string; prompt?: string; quick?: boolean } = {},
  ): Promise<AgentResult> => {
    const res = await inVault(get, (remote) =>
      agentCap.start(remote, { ...opts, ...geometry(get) }),
    )
    if (!res.ok) return res
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
      const started = await inVault(get, (remote) =>
        agentCap.start(remote, { name: args.text, ...geometry(get) }),
      )
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

/** Stop a session: `claude stop`. Its conversation stays in the history. */
export const stopSessionAtom = atom(null, (get, _set, id: string) =>
  inVault(get, (remote) => agentCap.stop(remote, { id })),
)

/** A fresh process for the same conversation: `claude respawn`. It picks up
 *  changed settings and `AGENTS.md`. */
export const respawnSessionAtom = atom(null, (get, _set, id: string) =>
  inVault(get, (remote) => agentCap.respawn(remote, { id })),
)

/** Copy a session's conversation into a background session of its own, and
 *  open it. Main reads Claude Code's conversation id at the moment of the fork. */
export const duplicateSessionAtom = atom(
  null,
  async (get, set, id: string): Promise<AgentResult> => {
    const res = await inVault(get, (remote) => agentCap.duplicate(remote, { id, ...geometry(get) }))
    if (!res.ok) return res
    land(set, res.sessionId)
    return { ok: true }
  },
)

/** A message from a session's chat: sent as a turn. */
export const sayAtom = atom(
  null,
  (get, _set, args: { id: string; text: string }): Promise<AgentResult> =>
    inVault(get, (remote) => agentCap.say(remote, { ...args, ...geometry(get) })).then(
      (res) => (res.ok ? { ok: true } : res),
      // A refusal that throws (main has no such capability, the vault closed
      // under it) is still an answer: the chat puts the text back and says why.
      (err: unknown) => ({ ok: false, message: failure(err) }),
    ),
)

/** Write an image the person attached into the vault, where the session can
 *  read it: answers its path. */
export const uploadAtom = atom(
  null,
  (get, _set, args: { name: string; data: string }): Promise<UploadAnswer> =>
    inVault(get, (remote) => agentCap.upload(remote, args)).then(
      (res) => res,
      (err: unknown) => ({ ok: false as const, message: failure(err) }),
    ),
)
type UploadAnswer = { ok: true; path: string } | { ok: false; message: string }

/** Why a call to main failed, in words for the chat. */
export function failure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Main is older than this window: a running Holi keeps its main process
  // until it is restarted.
  return /no such method/i.test(message)
    ? 'Holi needs a restart before the chat can reach its sessions.'
    : message
}

/** How long a terminal just opened gets to draw its dialog before a key
 *  meant for that dialog goes in. */
const KEY_SETTLE_MS = 700

/** The terminal on a session, opening one when there is none: what a key for
 *  its dialog is typed into, and what "show the terminal" shows. */
export const ensureTerminalAtom = atom(
  null,
  async (get, _set, id: string): Promise<{ terminalId: string; fresh: boolean } | null> => {
    const existing = get(agentTerminalsAtom).find((t) => t.launchedFor === id)
    if (existing !== undefined) return { terminalId: existing.id, fresh: false }
    const res = await inVault(get, (remote) =>
      agentCap.open(remote, { attach: id, ...geometry(get) }),
    )
    return res.ok ? { terminalId: res.terminalId, fresh: true } : null
  },
)

/**
 * Press keys in a session's terminal: Enter to allow what it asks, Escape to
 * refuse it or to interrupt a turn. The chat cannot draw Claude Code's
 * dialogs, so it answers the ones it can name with the key that answers them.
 */
export const pressAtom = atom(
  null,
  async (get, set, args: { id: string; keys: string }): Promise<AgentResult> => {
    const remote = get(activeRemoteAtom)
    const terminal = await set(ensureTerminalAtom, args.id).catch(() => null)
    if (remote === null || terminal === null) {
      return { ok: false, message: 'No terminal could be opened on that session.' }
    }
    if (terminal.fresh) await new Promise((done) => setTimeout(done, KEY_SETTLE_MS))
    typeIntoTerminal(remote, terminal.terminalId, args.keys)
    return { ok: true }
  },
)
