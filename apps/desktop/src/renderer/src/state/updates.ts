import { atom, type createStore } from 'jotai'
import type { UpdateStatus } from '../../../main/updates/state'
import { trpc } from '../lib/trpc'

/**
 * Updating Holi itself (docs/features/updates.md). `null` until main first
 * answers. Main pushes the whole status on every change, so this is a mirror,
 * never a cache to reconcile.
 */
export const updateStatusAtom = atom<UpdateStatus | null>(null)

type JotaiStore = ReturnType<typeof createStore>

/** Mirror the updater's status for the app's lifetime: asked once, then
 *  pushed. Established where the store is made, like the vault's pushes. */
export function subscribeToUpdates(store: JotaiStore): () => void {
  const off = window.holi.updates.onStatus((status) => store.set(updateStatusAtom, status))
  void trpc.updates.status.query().then((status) => {
    // A push that landed first is newer than this answer.
    if (store.get(updateStatusAtom) === null) store.set(updateStatusAtom, status)
  })
  return off
}

export const checkForUpdateAtom = atom(null, async (_get, set) => {
  set(updateStatusAtom, await trpc.updates.check.mutate())
})

export const retryUpdateDownloadAtom = atom(null, async (_get, set) => {
  set(updateStatusAtom, await trpc.updates.download.mutate())
})

export const installUpdateAtom = atom(null, async () => {
  await trpc.updates.install.mutate()
})

export const setAutoUpdateAtom = atom(null, async (_get, set, enabled: boolean) => {
  set(updateStatusAtom, await trpc.updates.setEnabled.mutate({ enabled }))
})

/** One line on where the updater has got to, for Settings. */
export function updateHeadline(status: UpdateStatus | null): string {
  if (status === null) return 'Loading…'
  if (!status.supported) return 'Updates arrive only in the installed app'
  const v = status.availableVersion === null ? 'An update' : `Holi ${status.availableVersion}`
  switch (status.state) {
    case 'ready':
      return `${v} is ready: restart to update`
    case 'available':
      return status.lastError === null ? `${v} is available` : `${v} could not be downloaded`
    case 'downloading':
      return status.percent === null ? `Downloading ${v}…` : `Downloading ${v}… ${status.percent}%`
    case 'checking':
      return 'Checking for updates…'
    case 'idle':
      return status.lastError === null ? 'Holi is up to date' : 'The last check failed'
  }
}
