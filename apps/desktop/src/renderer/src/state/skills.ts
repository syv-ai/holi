/**
 * Update skills, from the palette: this release's skills and hooks, merged
 * into the vault (`holi skills update` does the same from a shell).
 *
 * A file the vault changed too cannot be merged by Holi. Main answers with
 * the first turn of a session that would merge it, and the agent service
 * starts that session; with no agent the new versions wait beside the files.
 * The outcome is told as a notification.
 *
 * Whether an update exists is asked whenever a vault opens and after every
 * update, and the nav's update item offers it while it does
 * (docs/features/updates.md). Asking writes nothing.
 */
import { atom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { vaultCapabilities } from '../../../main/capabilities/vault-caps'
import { capClient } from '../lib/cap-client'
import { agentSourceAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

const skills =
  capClient<Pick<ReturnType<typeof vaultCapabilities>, 'skills.update' | 'skills.status'>>('skills')

/** The shipped files an update would bring the open vault, by path. Empty
 *  until asked, and for a vault that is up to date. */
const pendingSkillsAtom = atom<{ remote: string; pending: readonly string[] } | null>(null)

/**
 * Per vault, the pending set a person said "Not now" to, joined. Kept until
 * a later release changes the set, so the same offer is not made twice and a
 * new one still is. This machine's choice: nothing is written to the vault.
 */
const skillsDismissedAtom = atomWithStorage<Record<string, string>>('holi:skillsDismissed', {})

const signature = (pending: readonly string[]): string => [...pending].sort().join('\n')

/** What the nav offers for the open vault: the files an update would bring,
 *  or null while there is nothing to offer, or it was put off. */
export const skillsOfferAtom = atom((get): readonly string[] | null => {
  const remote = get(activeRemoteAtom)
  const pending = get(pendingSkillsAtom)
  if (remote === null || pending === null || pending.remote !== remote) return null
  if (pending.pending.length === 0) return null
  if (get(skillsDismissedAtom)[remote] === signature(pending.pending)) return null
  return pending.pending
})

export const dismissSkillsOfferAtom = atom(null, (get, set) => {
  const pending = get(pendingSkillsAtom)
  if (pending === null) return
  set(skillsDismissedAtom, (d) => ({ ...d, [pending.remote]: signature(pending.pending) }))
})

const refreshPendingSkillsAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  try {
    const { pending } = await skills.status(remote)
    // A switch that landed meanwhile asks for itself.
    if (get(activeRemoteAtom) === remote) set(pendingSkillsAtom, { remote, pending })
  } catch {
    // The clone gone, or the vault left meanwhile: nothing to offer.
    if (get(activeRemoteAtom) === remote) set(pendingSkillsAtom, { remote, pending: [] })
  }
})

type JotaiStore = ReturnType<typeof createStore>

/** Ask again whenever the open vault changes, for the app's lifetime. */
export function watchPendingSkills(store: JotaiStore): () => void {
  const ask = () => void store.set(refreshPendingSkillsAtom)
  ask()
  return store.sub(activeRemoteAtom, ask)
}

function notify(body: string): void {
  try {
    new Notification('Update skills', { body })
  } catch {
    // No notifications here (a test, or a renderer without the API).
  }
}

export const updateSkillsAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  let body: string
  try {
    const result = await skills.update(remote)
    const agent = get(agentSourceAtom)
    body = result.summary
    if (result.conflicts !== null && agent !== null) {
      const started = await set(agent.start, {
        name: 'Update skills',
        prompt: result.conflicts.prompt,
      })
      if (started.ok) body = result.conflicts.summary
    }
  } catch (err) {
    body = err instanceof Error ? err.message : String(err)
  }
  notify(body)
  await set(refreshPendingSkillsAtom)
})
