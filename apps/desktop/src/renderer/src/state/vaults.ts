import { atom, type createStore } from 'jotai'
import type { DocMeta, VaultEntry, VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import { flushAllBuffers } from '../lib/buffer-registry'
import { scaffoldNoteText } from '../lib/scaffold'
import { trpc } from '../lib/trpc'
import { retargetTab, workspaceAtom } from './panes'

type JotaiStore = ReturnType<typeof createStore>

export const vaultsAtom = atom<VaultEntry[]>([])

/** False until the first `loadVaults` resolves, so the App gate can tell an
 *  empty list (first run) apart from a not-yet-loaded one. */
export const vaultsLoadedAtom = atom(false)

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
  set(vaultsLoadedAtom, true)
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
 * FR-7: clone a repo the user already has, and open it.
 *
 * `vaults.add` clones into the managed root, seeds, registers, and opens in one
 * procedure — so the snapshot it returns is the vault that is now live, and the
 * list is re-read because the vault would otherwise be open and missing from
 * the dropdown at the same time.
 *
 * Deliberately does **not** swallow a refusal. A clone fails for reasons the
 * user can act on — no network, no access, a repo that is not there — and a
 * silent failure leaves the dropdown unchanged with nothing saying why.
 */
export const addVaultAtom = atom(null, async (_get, set, remote: string) => {
  const snapshot = await trpc.vaults.add.mutate({ remote })
  set(activeRemoteAtom, remote)
  set(snapshotAtom, snapshot)
  set(activeDocAtom, null)
  await set(loadVaultsAtom)
})

/**
 * FR-8: a new private repo, seeded, committed, pushed, opened.
 *
 * The push is not optional and the router does it rather than the caller: a
 * vault that exists only locally is not one anybody can be invited to.
 *
 * **`owner` is required here even though the router makes it optional.**
 * `vaults.create` answers with a snapshot rather than the repo, so the only way
 * the renderer can name the vault it just made is by knowing the owner up
 * front — and defaulting to the signed-in account would mean *guessing* the
 * remote and opening the wrong one. The UI always has a login to supply.
 */
export const createVaultAtom = atom(
  null,
  async (_get, set, input: { name: string; owner: string }) => {
    const snapshot = await trpc.vaults.create.mutate(input)
    const remote = `${input.owner}/${input.name}`
    set(activeRemoteAtom, remote)
    set(snapshotAtom, snapshot)
    set(activeDocAtom, null)
    await set(loadVaultsAtom)
  },
)

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
  // New notes open with starter frontmatter (title + created) so the metadata
  // is there from the start. Local date, to match how the daily note is dated.
  const isoDate = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
  await trpc.notes.create.mutate({ remote, path, text: scaffoldNoteText(isoDate) })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})

/** What links to `path` — the delete-preview fetch (FR-12). Empty, and no call,
 * when nothing is open: the dialog has nothing to warn about anyway. */
export const backrefsFor = atom(
  null,
  async (get, _set, path: string): Promise<{ path: string; count: number }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote) return []
    return trpc.notes.backrefs.query({ remote, path })
  },
)

/** Clears the editor when it is the open note being deleted — otherwise the pane
 * holds a doc that no longer exists. */
export const deleteNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.delete.mutate({ remote, path })
  if (get(activeDocAtom)?.path === path) set(activeDocAtom, null)
  await set(loadSnapshotAtom)
})

/**
 * Rename a note: move the file, rewrite inbound links, follow the open tab (FR-11).
 *
 * The order is the correctness: flush the live buffer and commit a clean
 * restore point *before* the multi-file edit, so every step after is
 * recoverable (there is no transaction — prd/notes-editor.md §Rename). Then the
 * rename, then a second commit so it lands as one commit on safe ground. The
 * open tab and active doc follow the file to its new path — a missed tab points
 * at something that no longer exists.
 */
export const renameNoteAtom = atom(
  null,
  async (get, set, { from, to }: { from: string; to: string }) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.rename.mutate({ remote, from, to })
    set(workspaceAtom, retargetTab(get(workspaceAtom), from, to))
    const wasActive = get(activeDocAtom)?.path === from
    await set(loadSnapshotAtom)
    if (wasActive) set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === to) ?? null)
    await trpc.sync.commitNow.mutate()
  },
)
