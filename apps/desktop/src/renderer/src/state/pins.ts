/**
 * The sidebar's Pinned section: the notes and folders you keep within reach,
 * per vault, on this machine (docs/features/sidebar.md).
 *
 * **Machine-local, not committed.** What one person keeps at hand is not a
 * decision about the vault, so it does not travel with it, as a sidebar's
 * width does not. Keyed by remote, so each vault keeps its own list.
 *
 * A pin names a vault-relative path. One whose file has gone (renamed, moved
 * away, deleted) is not shown, rather than removed, so a rename by the agent
 * that is undone brings it back; pinning the new path is a gesture away.
 */
import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { activeRemoteAtom, snapshotAtom } from './vaults'

export const pinsByVaultAtom = atomWithStorage<Record<string, string[]>>('holi:pins', {})

/** The open vault's pins, in the order they were pinned, without the ones
 *  whose path is no longer in the vault. */
export const pinsAtom = atom((get): string[] => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return []
  const snapshot = get(snapshotAtom)
  const present = new Set([
    ...snapshot.docs.map((d) => d.path),
    ...snapshot.files.map((f) => f.path),
    ...snapshot.dirs,
  ])
  return (get(pinsByVaultAtom)[remote] ?? []).filter((path) => present.has(path))
})

/** Pin a path in the open vault, or unpin it if it is pinned. */
export const togglePinAtom = atom(null, (get, set, path: string): void => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  const all = get(pinsByVaultAtom)
  const mine = all[remote] ?? []
  set(pinsByVaultAtom, {
    ...all,
    [remote]: mine.includes(path) ? mine.filter((p) => p !== path) : [...mine, path],
  })
})
