/**
 * What you *do* to the vault's agent: start a session, and send one an ask.
 *
 * Separate from `state/agent.ts`, which is what the agent *is* — the pushed
 * list, the tab you are looking at, the geometry. These need the open vault, and
 * they are what `state/vaults.ts` used to reach for, so a third module is what
 * keeps those two from importing each other.
 *
 * **Everything that spawns a session comes through `startSessionAtom`**, which
 * is why it exists: a spawn is not one call but three steps — the vault guard,
 * the tab you land on, and the colour mode that session read out of its config.
 * A second spawn path is a second place to forget one of them.
 */
import { atom, type Getter, type Setter } from 'jotai'
import { buildReconcilePrompt } from '../lib/reconcile-prompt'
import { trpc } from '../lib/trpc'
import {
  activeSessionAtom,
  activeSessionIdAtom,
  agentGeometryAtom,
  agentModeAtSpawnAtom,
  agentSessionsAtom,
  type AgentTarget,
} from './agent'
import { openSession, workspaceAtom } from './panes'
import { activeModeAtom } from './color-scheme'
import { activeRemoteAtom } from './vaults'

/** What a start answers with: the new session's id, or why there isn't one. */
export interface StartResult {
  ok: boolean
  id?: string
  message?: string
}

/**
 * What every spawn owes the app once main has made one: show it, and remember
 * the colour mode it was born under (D86).
 *
 * Shared by the two atoms below, which are the only things that can produce a
 * session. A second copy of these three lines would be a second place to forget
 * one of them, and the colour mode is the one that would go quietly: a session
 * missing from that map simply never nudges you to restart it.
 */
function land(get: Getter, set: Setter, id: string): void {
  // Show it: someone who asked for a session is asking to look at it.
  set(activeSessionIdAtom, id)
  set(workspaceAtom, (w) => openSession(w, id))
  // What Claude just read out of its settings, for this session alone (D86).
  set(agentModeAtSpawnAtom, (m) => ({ ...m, [id]: get(activeModeAtom) }))
}

/**
 * Start one session in the open vault and show it.
 *
 * Showing it is opening its tab (D101). It used to be opening the drawer, which
 * had to happen BEFORE the spawn so that the drawer's own auto-start could see a
 * start in flight and stand down. Nothing watches a flag any more: a tab is
 * opened for a session that exists, after it exists.
 */
export const startSessionAtom = atom(
  null,
  async (
    get,
    set,
    opts: { name?: string; resume?: boolean; prompt?: string; paste?: string } = {},
  ): Promise<StartResult> => {
    // A vault's identity is its remote (D60); it is what main matches against
    // the vault it has open, so a start with the wrong one is refused there.
    const remote = get(activeRemoteAtom)
    if (remote === null) return { ok: false, message: 'No vault is open.' }
    const { cols, rows } = get(agentGeometryAtom)
    const res = await window.holi.agent.start({ vaultId: remote, cols, rows, ...opts })
    if (!res.ok || res.id === undefined) {
      return { ok: false, ...(res.message === undefined ? {} : { message: res.message }) }
    }
    const id = res.id
    land(get, set, id)
    return { ok: true, id }
  },
)

/**
 * Rename a session: put Claude Code's own command in its box and get out of the
 * way (D101).
 *
 * **There is no dialog and no name field.** Holi cannot rename a session by
 * itself — `/rename` is the only route Claude Code offers, there is no shell
 * equivalent, and the command has to be typed into the session. So Holi types
 * the half it knows, focuses the tab, and the name is typed where it is going to
 * be read. A field in Holi would have collected a name only to paste it into a
 * box the user is now looking at anyway.
 *
 * Unsent, like everything Holi writes: appending the Enter would submit whatever
 * draft was already sitting in that composer, as a prompt nobody meant to send.
 */
export const renameSessionAtom = atom(
  null,
  async (_get, set, id: string): Promise<{ ok: boolean; message?: string }> =>
    // The trailing space is the point: the caret lands where the name goes.
    set(sendToAgentAtom, { text: '/rename ', target: id }),
)

/**
 * Copy a session's conversation into one of its own (D101).
 *
 * Main resolves which conversation that is — Claude Code's session id, read out
 * of its listing at the moment of the fork — so the renderer never holds one.
 * What comes back is an ordinary Holi session, landed on like any other.
 */
export const duplicateSessionAtom = atom(
  null,
  async (get, set, id: string): Promise<{ ok: boolean; message?: string }> => {
    const res = await window.holi.agent.duplicate(id)
    if (!res.ok || res.id === undefined) {
      return { ok: false, ...(res.message === undefined ? {} : { message: res.message }) }
    }
    land(get, set, res.id)
    return { ok: true }
  },
)

/**
 * Go to the agent: ⌘J.
 *
 * Opens the current session's tab, or starts one when the vault has none —
 * "there is nowhere to talk to the agent" is answered by making somewhere,
 * which is the rule the drawer had and the one thing worth keeping from it.
 *
 * **It does not toggle.** A drawer was a thing to open and shut; a tab is a
 * place to go, and ⌘J pressed twice should leave you where it put you rather
 * than undoing itself.
 */
export const showAgentAtom = atom(null, (get, set): void => {
  const current = get(activeSessionAtom)
  // An exited session is a record to read, not somewhere to be sent to work, so
  // the door steps over it — to another live one if the vault has one, and to a
  // new one if it does not. Its tab stays where it is; this is about where you
  // are being put, not about tidying up.
  const target =
    current !== null && !current.exited
      ? current
      : (get(agentSessionsAtom).find((s) => !s.exited) ?? null)
  if (target === null) {
    void set(startSessionAtom)
    return
  }
  set(activeSessionIdAtom, target.id)
  set(workspaceAtom, (w) => openSession(w, target.id))
})

/**
 * Send text to a session, live or new. It lands in the input box **unsent**
 * (D100) and that session's tab comes forward.
 *
 * One rule for every sender, which is the point: nothing Holi writes can append
 * a submit to a draft somebody was half way through typing. A `'new'` target is
 * spawned with `--name` from the ask's first line, so its tab is named from the
 * moment it exists, and main holds the paste until that session's TUI is up.
 *
 * A target that ended between being picked and being sent to is **refused**, not
 * silently dropped: the caller still has the text, and the answer it gets back
 * is what lets it keep it.
 */
export const sendToAgentAtom = atom(
  null,
  async (
    _get,
    set,
    args: { text: string; target: AgentTarget },
  ): Promise<{ ok: boolean; message?: string }> => {
    if (args.target === 'new') {
      const res = await set(startSessionAtom, { name: args.text, paste: args.text })
      return res.ok
        ? { ok: true }
        : { ok: false, message: res.message ?? 'Could not start a session.' }
    }
    const res = await window.holi.agent.paste(args.target, args.text)
    if (!res.ok) return res
    // Focus the tab the text just landed in, opening it if it was closed: an ask
    // that arrives somewhere you cannot see is an ask you will not answer.
    set(activeSessionIdAtom, args.target)
    set(workspaceAtom, (w) => openSession(w, args.target))
    return { ok: true }
  },
)

/**
 * "Ask Claude to reconcile" (FR-18). Re-materialise the conflict in the working
 * tree (main re-runs the merge), then give it its own session with the conflicted
 * paths as a submitted first turn. If the merge now applies cleanly (no paths),
 * the banner is already cleared and there is nothing to hand the agent.
 *
 * **The one submitted send.** Everywhere else an ask is pasted and left for the
 * user to send; a reconcile is a job Holi asked for on their behalf, and it gets
 * a session of its own rather than a paste into a conversation already in
 * flight.
 */
export const reconcileAtom = atom(null, async (_get, set) => {
  const { paths } = await trpc.sync.reconcile.mutate()
  if (paths.length === 0) return
  await set(startSessionAtom, { prompt: buildReconcilePrompt(paths) })
})
