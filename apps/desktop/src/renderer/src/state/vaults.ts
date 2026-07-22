import { atom, type createStore } from 'jotai'
import type { DocMeta, VaultEntry, VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import { trpc } from '../lib/trpc'

type JotaiStore = ReturnType<typeof createStore>

export const vaultsAtom = atom<VaultEntry[]>([])

/** The open vault, as `owner/repo`. A vault has no id — the remote IS the
 * identity, and the clone's path is machine-local (types.ts §VaultEntry). */
export const activeRemoteAtom = atom<string | null>(null)

const EMPTY_SNAPSHOT: VaultSnapshot = { docs: [], tasks: [], broken: [] }

/**
 * The whole vault, as last read off disk.
 *
 * **One source.** The board, the tree and the editor all derive from this rather
 * than each holding a query of their own — under D60 there is no server pushing
 * per-entity events to keep several caches honest, so a second source would only
 * ever be a second chance to disagree.
 *
 * Refreshed by re-scanning after a write. That is a full walk-and-parse of the
 * vault, and deliberately so: a task set this size is imperceptible to re-read,
 * and the alternative is an index with an invalidation story bought before any
 * measurement asked for one (prd/tasks.md §Summary). The filesystem watcher will
 * replace the explicit refetch, not the shape.
 */
export const snapshotAtom = atom<VaultSnapshot>(EMPTY_SNAPSHOT)

/** The doc open in the editor. */
export const activeDocAtom = atom<DocMeta | null>(null)

/**
 * FR-21's one sync state, exactly as main computed it.
 *
 * **Never re-derived here.** `computeState` in `active-vault.ts` fixes the
 * priority order — a pause outranks a conflict, and the comment there explains
 * what it costs to get that backwards. The renderer's job is to render whatever
 * arrived, and `sync.state` is only the initial read before the first push.
 */
export const syncStateAtom = atom<SyncState>({ kind: 'up-to-date' })

export const loadVaultsAtom = atom(null, async (get, set) => {
  const vaults = await trpc.vaults.list.query()
  set(vaultsAtom, vaults)
  const active = get(activeRemoteAtom)
  if (!active && vaults[0]) set(activeRemoteAtom, vaults[0].remote)
})

export const loadSnapshotAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return set(snapshotAtom, EMPTY_SNAPSHOT)
  set(snapshotAtom, await trpc.vaults.snapshot.query({ remote }))
})

/**
 * Open a vault: `vaults.open`, not `vaults.snapshot`.
 *
 * Opening is what *starts* the watcher and the sync loop in main, and it hands
 * back the snapshot of the vault that is now live. A separate read afterwards
 * could only ever disagree with it.
 *
 * A vault switch in main is a teardown — exactly one `ActiveVault` exists, so
 * the previous vault stops pushing the moment this resolves. Nothing here may
 * keep a snapshot keyed by remote: there is only ever one vault's worth of
 * truth, and it belongs to whichever vault is open now.
 */
export const openVaultAtom = atom(null, async (_get, set, remote: string) => {
  const snapshot = await trpc.vaults.open.mutate({ remote })
  set(activeRemoteAtom, remote)
  set(snapshotAtom, snapshot)
  set(activeDocAtom, null)
})

/**
 * Subscribe to everything main pushes, for the lifetime of the app.
 *
 * Established once where the store is created — **not** from a component
 * effect. A subscription that unmounts with a component silently stops the tree
 * updating the moment that component is conditionally rendered away, and the
 * symptom is a vault that looks fine and is quietly stale.
 *
 * The snapshot replaces rather than merges. The channel carries the whole vault
 * every time precisely so that nothing downstream has to reconcile frames — an
 * over-eager push is free, and a missed one heals on the next tick.
 */
export function subscribeToVault(store: JotaiStore): () => void {
  const offSnapshot = window.holi.vault.onSnapshot((snapshot) => store.set(snapshotAtom, snapshot))
  const offSync = window.holi.vault.onSyncState((state) => store.set(syncStateAtom, state))
  return () => {
    offSnapshot()
    offSync()
  }
}

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.create.mutate({ remote, path })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})

/** Clears the editor when it is the open note being deleted — otherwise the pane
 * holds a doc that no longer exists. */
export const deleteNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.delete.mutate({ remote, path })
  if (get(activeDocAtom)?.path === path) set(activeDocAtom, null)
  await set(loadSnapshotAtom)
})

// `renameNoteAtom` / `renameFolderAtom` are deliberately absent, exactly as
// `notes.rename` is absent from the router: a rename must move the file AND
// rewrite every inbound `[[wiki-link]]` in one pass, and shipping the move half
// alone would silently break every link. `loadBackrefsAtom` and `createVaultAtom`
// went with the procedures they called — backrefs is a grep now, and creating a
// vault means cloning a GitHub repo (prd/auth-identity.md), not a server insert.
