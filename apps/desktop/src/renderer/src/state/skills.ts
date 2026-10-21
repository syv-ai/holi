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
 * A vault that turned on `autoUpdateSkills` is not offered the update: main
 * runs it once the vault has opened and caught up with its remote
 * (`main/vault/seed/update-on-open.ts`), and pushes what changed, which the
 * nav's update item says until it is seen. This side only shows it. Its
 * conflicts wait for a person to hand them to the agent; a session is never
 * started on an open.
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

/** What the update run on open did, until it is seen or the vault is left. */
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
  // Main runs it on open: offering it too would race that run.
  if (status.autoUpdate) return null
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

/** Ask where the open vault's skills stand. */
const refreshSkillsAtom = atom(null, async (get, set): Promise<void> => {
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
})

type JotaiStore = ReturnType<typeof createStore>

/**
 * Ask again whenever the open vault changes, and take main's notice of an
 * update it ran on open, for the app's lifetime. A switch drops the notice:
 * it was about the vault being left.
 */
export function watchPendingSkills(store: JotaiStore): () => void {
  const ask = () => {
    store.set(skillsNoticeStateAtom, null)
    void store.set(refreshSkillsAtom)
  }
  ask()
  const offRemote = store.sub(activeRemoteAtom, ask)
  const offNotice = window.holi.vault.onSkillsUpdated((notice) => {
    if (notice.remote !== store.get(activeRemoteAtom)) return
    store.set(skillsNoticeStateAtom, notice)
    void store.set(refreshSkillsAtom)
  })
  return () => {
    offRemote()
    offNotice()
  }
}

function notify(body: string): void {
  try {
    new Notification('Update skills', { body })
  } catch {
    // No notifications here (a test, or a renderer without the API).
  }
}

/**
 * Run the update, asked for: its conflicts go straight to an agent session and
 * the outcome is a notification.
 */
export const updateSkillsAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  let body: string
  try {
    const result = await skills.update(remote)
    set(skillsNoticeStateAtom, null)
    body = result.summary
    const agent = get(agentSourceAtom)
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
  await set(refreshSkillsAtom)
})
