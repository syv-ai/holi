/**
 * What you *do* to the vault's sessions: start one, copy, stop or restart it,
 * archive or delete one, write to it, press keys in it, answer what it asks,
 * and open its chat on whichever page draws one (`agentPageAtom`).
 *
 * Separate from `state/sessions.ts` (what the sessions *are*) because these
 * need the terminal geometry and the open vault. Where a chat lands and what
 * the page shows are the page's own (`agent-ui`).
 */
import { atom, type Getter } from 'jotai'
import { agentCap } from '../agent-cap'
import type { AskAnswers } from '../../shared/questions'
import { agentGeometryAtom, agentPageAtom, agentTerminalsAtom, type AgentResult } from './sessions'
import { pendingOpenAtom } from './questions'
import { activeRemoteAtom, type PluginStore } from '@/plugin-api'

export type { AgentResult } from './sessions'

const geometry = (get: Getter) => get(agentGeometryAtom)

const NO_VAULT = { ok: false as const, message: 'No vault is open.' }

/** No page draws a chat (`agentPageAtom`): there is nowhere to show one. */
export const NO_AGENTS_PAGE = {
  ok: false as const,
  message:
    "The agent's interface is off in this vault. Turn on Agent interface under Plugins in settings to open its chats.",
}

/** Run `call` against the open vault, or answer that there is none. */
function inVault<R>(
  get: Getter,
  call: (remote: string) => Promise<R>,
): Promise<R | typeof NO_VAULT> {
  const remote = get(activeRemoteAtom)
  return remote === null ? Promise.resolve(NO_VAULT) : call(remote)
}

/** A session started or copied: its job id, or why not. */
export type Started = { ok: true; sessionId: string } | { ok: false; message: string }

/**
 * One session, from the inbox, a schedule's run or the palette: its chat, on
 * the page that draws one, or refused when none does.
 */
export const openSessionAtom = atom(null, (get, set, id: string): Promise<AgentResult> => {
  const page = get(agentPageAtom)
  return page === null ? Promise.resolve(NO_AGENTS_PAGE) : set(page.open, id)
})

/**
 * A new background session. With a `prompt` that prompt is its first turn;
 * without one it waits for yours. Where it is shown is the caller's.
 */
export const startAtom = atom(
  null,
  (get, _set, opts: { name?: string; prompt?: string } = {}): Promise<Started> =>
    inVault(get, (remote) => agentCap.start(remote, { ...opts, ...geometry(get) })).catch(
      (err: unknown) => ({ ok: false as const, message: failure(err) }),
    ),
)

/** Copy a session's conversation into a background session of its own. Main
 *  reads Claude Code's conversation id at the moment of the fork. */
export const duplicateAtom = atom(null, (get, _set, id: string): Promise<Started> =>
  inVault(get, (remote) => agentCap.duplicate(remote, { id, ...geometry(get) })).catch(
    (err: unknown) => ({ ok: false as const, message: failure(err) }),
  ),
)

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

/** Stop a session: `claude stop`. Its conversation stays in the history. */
export const stopSessionAtom = atom(null, (get, _set, id: string) =>
  inVault(get, (remote) => agentCap.stop(remote, { id })),
)

/** A fresh process for the same conversation: `claude respawn`. It picks up
 *  changed settings and `AGENTS.md`. */
export const respawnSessionAtom = atom(null, (get, _set, id: string) =>
  inVault(get, (remote) => agentCap.respawn(remote, { id })),
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
  return message
}

/** The terminal on a session, opening one when there is none: what "show
 *  the terminal" shows. */
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
 * refuse it or to interrupt a turn, the runs that answer a question. The chat
 * cannot draw Claude Code's dialogs, so it answers the ones it can name with
 * the keys that answer them. Main opens a terminal when there is none, holds
 * the keys until it reads input and spaces the runs, so nothing here waits on
 * a clock. Keys that answer a prompt name its call (`expect`), and main
 * refuses them unless that call is still the only one open. A refusal (the
 * session ended, its terminal closed, the prompt moved on) comes back as one;
 * ok says the keys went to the terminal, and the session's own state says
 * whether they answered it.
 */
export const pressAtom = atom(
  null,
  (
    get,
    _set,
    args: { id: string; keys: string | readonly string[]; expect?: string },
  ): Promise<AgentResult> =>
    inVault(get, (remote) =>
      agentCap.press(remote, {
        id: args.id,
        keys: typeof args.keys === 'string' ? [args.keys] : [...args.keys],
        ...(args.expect === undefined ? {} : { expect: args.expect }),
        ...geometry(get),
      }),
    ).then(
      (res) => (res.ok ? { ok: true } : res),
      (err: unknown) => ({ ok: false, message: failure(err) }),
    ),
)

/**
 * Answer a question Holi holds for a session (a quick agent's, whose hook
 * keeps Claude Code from drawing its own box: docs/features/quick-agent.md).
 * Through the question desk, never as keys: there is no dialog to type into.
 */
export const answerHeldAtom = atom(
  null,
  (get, _set, args: { id: string; answers: AskAnswers }): Promise<AgentResult> =>
    inVault(get, (remote) => agentCap.answer(remote, args)).then(
      (res) =>
        res === true
          ? { ok: true }
          : typeof res === 'object'
            ? res
            : { ok: false, message: 'That question was answered or withdrawn already.' },
      (err: unknown) => ({ ok: false, message: failure(err) }),
    ),
)

/**
 * While `remote` is the open vault: open the session the quick panel asked
 * for (its ⏎ on a finished agent), now or as soon as it asks and a page is
 * there to show it. A main window opened for it hears the request before its
 * vault is open, so the request waits here rather than in the event.
 */
export function followPendingOpen(remote: string, store: PluginStore): () => void {
  const openPending = (): void => {
    const pending = store.get(pendingOpenAtom)
    if (pending === null || pending.remote !== remote || store.get(agentPageAtom) === null) return
    store.set(pendingOpenAtom, null)
    void store.set(openSessionAtom, pending.id)
  }
  openPending()
  const offPending = store.sub(pendingOpenAtom, openPending)
  const offPage = store.sub(agentPageAtom, openPending)
  return () => {
    offPending()
    offPage()
  }
}
