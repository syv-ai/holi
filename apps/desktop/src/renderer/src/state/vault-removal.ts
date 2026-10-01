/**
 * What the renderer does around leaving or deleting a vault. Main does
 * the GitHub call and the Trash; this keeps the app standing once a vault is
 * gone, and hands stuck work to the agent when one runs.
 */
import { atom } from 'jotai'
import { emptyVaultSnapshot } from '@holi/shared'
import { buildStuckPushPrompt } from '../lib/stuck-push-prompt'
import { trpc } from '../lib/trpc'
import { emptyWorkspace, workspaceAtom } from './panes'
import { agentSourceAtom } from './plugins'
import { switchVaultAtom } from './vault-switch'
import { activeDocAtom, activeRemoteAtom, snapshotAtom, vaultsAtom } from './vaults'

/**
 * A vault's clone is gone: re-read the list, and when it was the open vault,
 * move to the next one. With none left the App gate shows first run.
 */
export const vaultRemovedAtom = atom(null, async (get, set, remote: string) => {
  const wasActive = get(activeRemoteAtom) === remote
  const vaults = await trpc.vaults.list.query()
  set(vaultsAtom, vaults)
  if (!wasActive) return
  set(workspaceAtom, emptyWorkspace())
  set(snapshotAtom, emptyVaultSnapshot())
  set(activeDocAtom, null)
  set(activeRemoteAtom, vaults[0]?.remote ?? null)
})

/**
 * A session prompt waiting for its vault to open. A session starts only in the
 * open vault, so a stuck vault that is not open is switched to first, and
 * Shell starts this once the switch has opened it.
 */
export const pendingVaultPromptAtom = atom<{ remote: string; prompt: string } | null>(null)

/** Start a new session in `remote` that looks into why its work will not push.
 *  A new one each time: it never lands in a conversation already going. Does
 *  nothing with no agent, where the person is told where to look instead. */
export const investigateStuckPushAtom = atom(
  null,
  async (get, set, args: { remote: string; intent: 'leave' | 'delete' }) => {
    const agent = get(agentSourceAtom)
    if (agent === null) return
    const prompt = buildStuckPushPrompt(args.intent)
    if (get(activeRemoteAtom) === args.remote) {
      await set(agent.start, { prompt })
      return
    }
    set(pendingVaultPromptAtom, { remote: args.remote, prompt })
    set(switchVaultAtom, args.remote)
  },
)

/** Shell's half: once `remote` is open, start the session waiting for it. */
export const startPendingVaultPromptAtom = atom(null, async (get, set, remote: string) => {
  const pending = get(pendingVaultPromptAtom)
  if (pending === null || pending.remote !== remote) return
  set(pendingVaultPromptAtom, null)
  const agent = get(agentSourceAtom)
  if (agent !== null) await set(agent.start, { prompt: pending.prompt })
})
