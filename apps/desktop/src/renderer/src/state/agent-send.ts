/**
 * What you *do* to the vault's agent: start a session, and send one an ask.
 *
 * Separate from `state/agent.ts`, which is what the agent *is* — the pushed
 * list, the tab you are looking at, the geometry. These need the open vault, and
 * they are what `state/vaults.ts` used to reach for, so a third module is what
 * keeps those two from importing each other.
 *
 * **Everything that spawns a session comes through `startSessionAtom`**, which
 * is why it exists: a spawn is not one call but four steps — the vault guard,
 * the drawer, the tab you land on, and the colour mode that session read out of
 * its config. A second spawn path is a second place to forget one of them.
 */
import { atom } from 'jotai'
import { buildReconcilePrompt } from '../lib/reconcile-prompt'
import { trpc } from '../lib/trpc'
import {
  activeSessionIdAtom,
  agentGeometryAtom,
  agentModeAtSpawnAtom,
  agentPanelOpenAtom,
  agentSessionsAtom,
  type AgentTarget,
} from './agent'
import { activeModeAtom } from './color-scheme'
import { activeRemoteAtom } from './vaults'

/** What a start answers with: the new session's id, or why there isn't one. */
export interface StartResult {
  ok: boolean
  id?: string
  message?: string
}

/**
 * Start one session in the open vault and show it.
 *
 * It opens the drawer directly rather than through `showAgentPanelAtom`, and the
 * distinction is the whole reason that atom exists: opening the drawer is what
 * *asks* for a session when there is none, and this is already answering.
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
    set(agentPanelOpenAtom, true)
    const res = await window.holi.agent.start({ vaultId: remote, cols, rows, ...opts })
    if (!res.ok || res.id === undefined) {
      return { ok: false, ...(res.message === undefined ? {} : { message: res.message }) }
    }
    const id = res.id
    // Show it: someone who asked for a session is asking to look at it.
    set(activeSessionIdAtom, id)
    // What Claude just read out of its settings, for this session alone (D86).
    set(agentModeAtSpawnAtom, (m) => ({ ...m, [id]: get(activeModeAtom) }))
    return { ok: true, id }
  },
)

/**
 * Show or hide the drawer — and starting a session is part of showing it.
 *
 * **An empty drawer is not a place to talk to the agent**, so opening one onto a
 * vault with no live session starts one. That used to be an effect in
 * `AgentPanel` watching the open flag, which could not tell the drawer opening
 * itself apart from the drawer being opened BY a spawn: a reconcile or an ask
 * sent to a new session opens it on the way, and the session it is making is not
 * in the pushed list yet, so the effect started a second one. Owning both halves
 * here means there is no edge to misread.
 *
 * `'toggle'` is the door and ⌘J; an explicit boolean is the handle being dragged
 * to or from zero width.
 */
export const showAgentPanelAtom = atom(
  null,
  (get, set, next: boolean | 'toggle' = 'toggle'): void => {
    const open = next === 'toggle' ? !get(agentPanelOpenAtom) : next
    set(agentPanelOpenAtom, open)
    if (!open) return
    if (get(agentSessionsAtom).some((s) => !s.exited)) return
    void set(startSessionAtom)
  },
)

/**
 * Send text to a session, live or new. It lands in the input box **unsent**
 * (D100) and the drawer focuses that tab.
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
    set(activeSessionIdAtom, args.target)
    set(agentPanelOpenAtom, true)
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
