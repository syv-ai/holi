/**
 * What you *do* to the vault's assistant: open the agents list, open a
 * session, start one, send one an ask, stop, restart or copy it.
 *
 * Separate from `state/agent.ts` (what the assistant *is*) because these need
 * the terminal geometry and the workspace, and a third module keeps
 * `agent.ts` free of both.
 *
 * **Every window lands through `land`**: its tab comes forward and its
 * terminal takes the keyboard.
 */
import { atom, type Getter, type Setter } from 'jotai'
import { agentCap } from '../lib/agent-cap'
import { focusSessionTerminal } from '../lib/session-terminals'
import {
  AGENT_SURFACE,
  agentGeometryAtom,
  agentSessionsAtom,
  agentTerminalsAtom,
  sessionTitled,
  titleIsList,
  type AgentTarget,
  type AgentTerminal,
} from './agent'
import { openSurface, workspaceAtom } from './panes'
import { activeRemoteAtom } from './vaults'

/** What an action answers: done, or why not, in words the caller can print. */
export type AgentResult = { ok: true } | { ok: false; message: string }

/** Show a terminal's tab and give it the keyboard. A miss on the focus is
 *  fine: a terminal not built yet focuses itself when it is. */
function land(set: Setter, terminalId: string): void {
  // Deduped by id: two views over one PTY would both be attached to it.
  set(workspaceAtom, (w) => openSurface(w, AGENT_SURFACE, terminalId))
  focusSessionTerminal(terminalId)
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
 * Whether a terminal shows the agents list **now**. How it was launched does
 * not say: `←` and Enter move one terminal between the list and a session. Its
 * title does, because Claude Code titles the list `… claude agents` and a
 * session by its name. A list that has not titled itself yet is one Holi just
 * opened as the list.
 */
const showsList = (t: AgentTerminal): boolean =>
  t.title === '' ? t.launchedFor === null : titleIsList(t)

/**
 * ⌘J and the agent icon: the agents list.
 *
 * Focuses a terminal showing the list, the most recently opened if there are
 * several, else opens one. **It does not toggle**: pressed twice, it leaves
 * you where it put you.
 */
export const showAgentsAtom = atom(null, async (get, set): Promise<AgentResult> => {
  const existing = get(agentTerminalsAtom).filter(showsList).at(-1)
  if (existing !== undefined) {
    land(set, existing.id)
    return { ok: true }
  }
  const res = await inVault(get, (remote) => agentCap.open(remote, geometry(get)))
  if (!res.ok) return res
  land(set, res.terminalId)
  return { ok: true }
})

/**
 * Open overview, in an agent tab's bar: a **new** agents list every time. The
 * tab it sits in may itself be the list Holi opened, since `←` and Enter move
 * a terminal between the list and a session, so reusing one would only ever
 * bring you back to where you are.
 */
export const openOverviewAtom = atom(null, async (get, set): Promise<AgentResult> => {
  const res = await inVault(get, (remote) => agentCap.open(remote, geometry(get)))
  if (!res.ok) return res
  land(set, res.terminalId)
  return { ok: true }
})

/**
 * One session, from a sidebar row, an orb or the palette: a window whose title
 * names it (any tab, the list's included, may have attached it since), else the
 * window Holi opened for it, else a new `claude attach` window. An unnamed
 * session has only a generic title, so it can land in a second window; two
 * windows on one session only mirror each other, never wrong, just more.
 */
export const openSessionAtom = atom(null, async (get, set, id: string): Promise<AgentResult> => {
  const terminals = get(agentTerminalsAtom)
  const sessions = get(agentSessionsAtom)
  const existing =
    terminals.find((t) => sessionTitled(t, sessions)?.id === id) ??
    terminals.find((t) => t.launchedFor === id)
  if (existing !== undefined) {
    land(set, existing.id)
    return { ok: true }
  }
  const res = await inVault(get, (remote) =>
    agentCap.open(remote, { attach: id, ...geometry(get) }),
  )
  if (!res.ok) return res
  land(set, res.terminalId)
  return { ok: true }
})

/**
 * A new background session and its window. With a `prompt` that prompt is its
 * first turn (reconcile, a stuck push); without one it waits for yours.
 */
export const startSessionAtom = atom(
  null,
  async (get, set, opts: { name?: string; prompt?: string } = {}): Promise<AgentResult> => {
    const res = await inVault(get, (remote) =>
      agentCap.start(remote, { ...opts, ...geometry(get) }),
    )
    if (!res.ok) return res
    land(set, res.terminalId)
    return { ok: true }
  },
)

/**
 * Send text to a session, live or new. It lands in the input box **unsent** and
 * that session's window comes forward.
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
    const res = await inVault(get, (remote) => agentCap.send(remote, { ...args, ...geometry(get) }))
    if (!res.ok) return res
    land(set, res.terminalId)
    return { ok: true }
  },
)

/** Stop a session: `claude stop`. Its conversation stays in the agents list,
 *  and any window on it closes. */
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
    land(set, res.terminalId)
    return { ok: true }
  },
)
