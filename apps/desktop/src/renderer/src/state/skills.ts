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
 *
 * A vault that turned on `autoUpdateSkills` is not offered the update: when it
 * opens with one pending, the same update runs unasked, and the nav's update
 * item says what changed until it is seen. Its conflicts wait for a person to
 * hand them to the agent; a session is never started on an open.
 */
import { atom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type {
  SkillsStatus,
  SkillsUpdated,
  vaultCapabilities,
} from '../../../main/capabilities/vault-caps'
import { capClient } from '../lib/cap-client'
import { agentSourceAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

const skills =
  capClient<Pick<ReturnType<typeof vaultCapabilities>, 'skills.update' | 'skills.status'>>('skills')

/** Where the open vault's skills stand (`skills.status`): null until asked. */
const skillsStatusAtom = atom<(SkillsStatus & { remote: string }) | null>(null)

/** The open vault's skills status, or null until it has answered. */
export const openSkillsStatusAtom = atom((get): SkillsStatus | null => {
  const status = get(skillsStatusAtom)
  return status !== null && status.remote === get(activeRemoteAtom) ? status : null
})

/** What an update run on open did, until it is seen. Per vault, in memory. */
const skillsNoticeStateAtom = atom<(SkillsUpdated & { remote: string }) | null>(null)

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
  const status = get(openSkillsStatusAtom)
  if (remote === null || status === null || status.pending.length === 0) return null
  if (get(skillsDismissedAtom)[remote] === signature(status.pending)) return null
  return status.pending
})

export const dismissSkillsOfferAtom = atom(null, (get, set) => {
  const status = get(skillsStatusAtom)
  if (status === null) return
  set(skillsDismissedAtom, (d) => ({ ...d, [status.remote]: signature(status.pending) }))
})

/** What the update run on opening the open vault did, while it is unseen. */
export const skillsNoticeAtom = atom((get): SkillsUpdated | null => {
  const notice = get(skillsNoticeStateAtom)
  return notice !== null && notice.remote === get(activeRemoteAtom) ? notice : null
})

export const dismissSkillsNoticeAtom = atom(null, (_get, set) => set(skillsNoticeStateAtom, null))

/** The notice's conflicts, handed to an agent session as Update skills does. */
export const mergeSkillsConflictsAtom = atom(null, async (get, set): Promise<void> => {
  const notice = get(skillsNoticeStateAtom)
  const agent = get(agentSourceAtom)
  if (notice?.conflicts == null || agent === null) return
  const started = await set(agent.start, { name: 'Update skills', prompt: notice.conflicts.prompt })
  if (started.ok) set(skillsNoticeStateAtom, null)
})

/**
 * Ask where the open vault's skills stand. `onOpen`, as when a vault opens,
 * runs the update itself if the vault asks for that and one is pending.
 */
const refreshSkillsAtom = atom(null, async (get, set, onOpen: boolean): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  let status: SkillsStatus
  try {
    status = await skills.status(remote)
  } catch {
    // The clone gone, or the vault left meanwhile: nothing to offer.
    status = { pending: [], release: null, autoUpdate: false }
  }
  // A switch that landed meanwhile asks for itself.
  if (get(activeRemoteAtom) !== remote) return
  set(skillsStatusAtom, { ...status, remote })
  if (onOpen && status.autoUpdate && status.pending.length > 0) {
    await set(runSkillsUpdateAtom, 'open')
  }
})

type JotaiStore = ReturnType<typeof createStore>

/** Ask again whenever the open vault changes, for the app's lifetime. */
export function watchPendingSkills(store: JotaiStore): () => void {
  const ask = () => void store.set(refreshSkillsAtom, true)
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

/**
 * Run the update. Asked for, its conflicts go straight to an agent session
 * and the outcome is a notification. Run on open, nothing is started and
 * nothing pops up: what changed waits in the nav's update item.
 */
const runSkillsUpdateAtom = atom(null, async (get, set, why: 'asked' | 'open'): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  let body: string
  try {
    const result = await skills.update(remote)
    body = result.summary
    if (why === 'open') {
      body = ''
      if (result.changed.length > 0 || result.conflicts !== null) {
        set(skillsNoticeStateAtom, { ...result, remote })
      }
    } else {
      set(skillsNoticeStateAtom, null)
      const agent = get(agentSourceAtom)
      if (result.conflicts !== null && agent !== null) {
        const started = await set(agent.start, {
          name: 'Update skills',
          prompt: result.conflicts.prompt,
        })
        if (started.ok) body = result.conflicts.summary
      }
    }
  } catch (err) {
    body = err instanceof Error ? err.message : String(err)
    // Unasked, a failure is not worth an interruption: the offer stays.
    if (why === 'open') body = ''
  }
  if (body !== '') notify(body)
  await set(refreshSkillsAtom, false)
})

export const updateSkillsAtom = atom(null, (_get, set) => set(runSkillsUpdateAtom, 'asked'))
