/**
 * "Ask the agent to reconcile" (docs/features/vaults-sync.md). Main re-runs
 * the merge to put the conflict back in the working tree, then the agent
 * gets a session of its own with the conflicted paths as a submitted first
 * turn. If the merge now applies cleanly (no paths), the banner is already
 * cleared and there is nothing to hand over.
 *
 * **The one submitted send.** Everywhere else an ask is pasted and left for
 * the user to send; a reconcile is a job Holi asked for on their behalf, and
 * it gets a session of its own rather than a paste into a conversation
 * already in flight. Offered only while an agent runs: without one, "Try
 * again" is the way out of a conflict.
 */
import { atom } from 'jotai'
import { buildReconcilePrompt } from '../lib/reconcile-prompt'
import { trpc } from '../lib/trpc'
import { agentSourceAtom } from './plugins'

export const reconcileAtom = atom(null, async (get, set) => {
  const agent = get(agentSourceAtom)
  if (agent === null) return
  const { paths } = await trpc.sync.reconcile.mutate()
  if (paths.length === 0) return
  await set(agent.start, { name: 'Reconcile', prompt: buildReconcilePrompt(paths) })
})
