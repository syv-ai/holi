import { atom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import {
  type DocMeta,
  GITKEEP,
  scaffoldNoteText,
  type VaultEntry,
  type VaultSnapshot,
  emptyVaultSnapshot,
} from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import type { HeldBackFile } from '../../../main/vault/large-files'
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import {
  appOpensAtom,
  closeTabsForPaths,
  openApp,
  retargetTab,
  retargetTabs,
  workspaceAtom,
} from './panes'
import { openTaskAtom } from './view'

type JotaiStore = ReturnType<typeof createStore>

export const vaultsAtom = atom<VaultEntry[]>([])

/** False until the first `loadVaults` resolves, so the App gate can tell an
 *  empty list (first run) apart from a not-yet-loaded one. */
export const vaultsLoadedAtom = atom(false)

/** The open vault, as `owner/repo`. A vault has no id: the remote IS the
 * identity, and the clone's path is machine-local. */
export const activeRemoteAtom = atom<string | null>(null)

/**
 * Per-vault "show hidden files" preference, persisted across launches. One
 * localStorage key holds a `{ [remote]: boolean }` map; a vault absent from it
 * defaults to hidden (`false`). Display-only: it gates the tree's `isHiddenPath`
 * filter and touches nothing about scanning, opening, or sync.
 */
export const showHiddenByVaultAtom = atomWithStorage<Record<string, boolean>>('holi:showHidden', {})

/** Per-vault "show task files in the tree" flag, off by default: the board owns
 * tasks. Purely a view filter; task files are always scanned into
 * `snapshot.tasks`. */
export const showTasksByVaultAtom = atomWithStorage<Record<string, boolean>>('holi:showTasks', {})

const EMPTY_SNAPSHOT: VaultSnapshot = emptyVaultSnapshot()

/**
 * The whole vault, as last read off disk.
 *
 * **One source**. The board, the tree and the editor all derive from this
 * rather than each holding a query of their own, so there is nothing to
 * disagree with.
 *
 * Main pushes a fresh full snapshot on every watcher tick, and writes here also
 * refetch. A full walk-and-parse is deliberate: an index with an invalidation
 * story has not been asked for by any measurement (`docs/features/tasks.md`).
 */
export const snapshotAtom = atom<VaultSnapshot>(EMPTY_SNAPSHOT)

/** The doc open in the editor. */
export const activeDocAtom = atom<DocMeta | null>(null)

/**
 * The one sync state, exactly as main computed it.
 *
 * **Never re-derived here.** `computeState` in `active-vault.ts` fixes the
 * priority order (a pause outranks a conflict). `sync.state` is only the initial
 * read before the first push.
 */
export const syncStateAtom = atom<SyncState>({ kind: 'up-to-date' })

/** Files the large-file gate held out of the last commit: the callout's source.
 *  Pushed from main every commit tick (empty clears it, incl. on a vault switch). */
export const heldBackAtom = atom<HeldBackFile[]>([])

/**
 * How often each file's history has moved since launch: `all` counts merged
 * pulls (which may touch any file), `byPath` counts the commits that took that
 * path. Read through `historyEpoch`; only its changes matter, never its value.
 */
export interface HistoryEpochs {
  all: number
  byPath: Readonly<Record<string, number>>
}

export const historyEpochsAtom = atom<HistoryEpochs>({ all: 0, byPath: {} })

/** Bumps the epochs for one `onCommitted` push. */
export function bumpHistoryEpochs(epochs: HistoryEpochs, paths: string[] | null): HistoryEpochs {
  if (paths === null) return { ...epochs, all: epochs.all + 1 }
  const byPath = { ...epochs.byPath }
  for (const p of paths) byPath[p] = (byPath[p] ?? 0) + 1
  return { ...epochs, byPath }
}

/** A number that changes whenever `path`'s git history may have. */
export function historyEpoch(epochs: HistoryEpochs, path: string): number {
  return epochs.all + (epochs.byPath[path] ?? 0)
}

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
 * Open a vault: `vaults.open`, not `vaults.snapshot`. Opening is what *starts*
 * the watcher and the sync loop in main, and it hands back the live snapshot.
 *
 * A vault switch in main is a teardown: exactly one `ActiveVault` exists. Nothing
 * here may keep a snapshot keyed by remote.
 */
export const openVaultAtom = atom(null, async (_get, set, remote: string) => {
  const snapshot = await trpc.vaults.open.mutate({ remote })
  set(activeRemoteAtom, remote)
  set(snapshotAtom, snapshot)
  set(activeDocAtom, null)
})

/**
 * Clone a repo the user already has, and open it.
 *
 * `vaults.add` clones, seeds, registers, and opens in one procedure; the list is
 * re-read so the open vault is not missing from the dropdown.
 *
 * Deliberately does **not** swallow a refusal: a clone fails for reasons the
 * user can act on (no network, no access, no such repo).
 */
export const addVaultAtom = atom(null, async (_get, set, remote: string) => {
  const snapshot = await trpc.vaults.add.mutate({ remote })
  set(activeRemoteAtom, remote)
  set(snapshotAtom, snapshot)
  set(activeDocAtom, null)
  await set(loadVaultsAtom)
})

/**
 * A new private repo, seeded, committed and pushed. The router pushes rather
 * than the caller: a vault that exists only locally cannot be shared.
 *
 * **Deliberately does NOT refresh the vault list, and does NOT activate the
 * vault.** The first-run gate flips to the Shell the moment `vaultsAtom` becomes
 * non-empty, which would unmount the onboarding ritual mid-success. Activating
 * here would also open the vault before the settings act had asked anything, so
 * the answers would land after the seeded defaults were read. The ritual
 * activates the vault when it is finished.
 *
 * **`owner` is required here even though the router makes it optional.**
 * `vaults.create` answers with a snapshot rather than the repo, and defaulting
 * to the signed-in account would mean *guessing* the remote.
 *
 * Returns the `owner/repo` remote.
 */
export const createVaultAtom = atom(
  null,
  async (_get, set, input: { name: string; owner: string }): Promise<string> => {
    await trpc.vaults.create.mutate(input)
    return `${input.owner}/${input.name}`
  },
)

/**
 * Subscribe to everything main pushes, for the lifetime of the app.
 *
 * Established once where the store is created, **not** from a component effect:
 * a subscription that unmounts with a component leaves the vault quietly stale.
 *
 * The snapshot replaces rather than merges: the channel carries the whole vault
 * every time, so a missed push heals on the next tick.
 */
export function subscribeToVault(store: JotaiStore): () => void {
  const offSnapshot = window.holi.vault.onSnapshot((snapshot) => store.set(snapshotAtom, snapshot))
  const offSync = window.holi.vault.onSyncState((state) => store.set(syncStateAtom, state))
  const offHeldBack = window.holi.vault.onHeldBack((files) => store.set(heldBackAtom, files))
  const offCommitted = window.holi.vault.onCommitted((paths) =>
    store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, paths)),
  )
  // A clicked reminder opens its task. Cross-vault, the switch runs here, not in
  // main, so `activeRemoteAtom` stays truthful; the task opens once the new
  // vault's snapshot is in (`openVaultAtom` sets it before this resolves).
  const offReminder = window.holi.reminders.onOpen(({ remote, path }) => {
    if (remote && remote !== store.get(activeRemoteAtom)) {
      void store.set(openVaultAtom, remote).then(() => store.set(openTaskAtom, path))
    } else {
      store.set(openTaskAtom, path)
    }
  })
  // `holi app open <id>`, typed by the agent. Local authorship only: see the
  // channel's own comment for why an app appearing in the snapshot does not
  // open anything. An app already open reloads (`appOpensAtom`).
  const offAppOpen = window.holi.apps.onOpen((bundle) => {
    store.set(workspaceAtom, (w) => openApp(w, bundle))
    store.set(appOpensAtom, (n) => ({ ...n, [bundle]: (n[bundle] ?? 0) + 1 }))
  })
  return () => {
    offSnapshot()
    offSync()
    offHeldBack()
    offCommitted()
    offReminder()
    offAppOpen()
  }
}

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  // A markdown note opens with starter frontmatter; any other file type is
  // created empty.
  const text = path.endsWith('.md') ? scaffoldNoteText() : ''
  await trpc.notes.create.mutate({ remote, path, text })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})

/** Make a folder real on disk. Git tracks no empty directory, so we drop a
 *  `.gitkeep` inside it: the scanner surfaces the folder in `snapshot.dirs` (the
 *  keep-file itself is never shown), and an empty folder survives a clone.
 *  `notes.write` upserts, so re-creating an existing folder is a no-op. */
export const createFolderAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.write.mutate({ remote, path: `${path}/${GITKEEP}`, text: '' })
  await set(loadSnapshotAtom)
})

/** What links to `path`: the delete-preview fetch. Empty, and no call, when
 * nothing is open. */
export const backrefsFor = atom(
  null,
  async (get, _set, path: string): Promise<{ path: string; count: number }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote) return []
    return trpc.notes.backrefs.query({ remote, path })
  },
)

/**
 * "Abandon": takes the merge back out of the tree. The conflict is still a
 * conflict, so the banner comes back. The agent's session stays where it is, and
 * whatever it wrote into the working tree goes with the merge.
 */
export const abandonReconcileAtom = atom(null, async () => {
  await trpc.sync.abandon.mutate()
})

/**
 * Rename a note: move the file, rewrite inbound links, follow the open tab.
 *
 * The order is the correctness: flush the live buffer and commit a clean
 * restore point *before* the multi-file edit, so every step after is
 * recoverable (there is no transaction, `docs/features/wiki-links.md`). Then the
 * rename, then a second commit so it lands as one commit on safe ground.
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

/**
 * Batch move (folder rename/delete-to-move, drag, cut+paste). Same order as
 * `renameNoteAtom`, one commit-pair for the whole batch: flush the live buffer
 * and commit a clean restore point, run the single-pass `notes.move`, retarget
 * every open tab, reload the snapshot, follow the active doc, commit again.
 */
export const moveNotesAtom = atom(
  null,
  async (get, set, { moves }: { moves: { from: string; to: string }[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || moves.length === 0) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.move.mutate({ remote, moves })
    set(workspaceAtom, retargetTabs(get(workspaceAtom), moves))
    const active = get(activeDocAtom)
    const moved = active ? moves.find((m) => m.from === active.path) : undefined
    await set(loadSnapshotAtom)
    if (moved) set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === moved.to) ?? null)
    await trpc.sync.commitNow.mutate()
  },
)

/**
 * Batch copy (Duplicate, Copy+Paste). No link rewrite and no tab retarget, but
 * the same commit-pair ordering, and the flush ensures a copy of a note being
 * edited includes the latest keystrokes.
 */
export const copyNotesAtom = atom(
  null,
  async (get, set, { copies }: { copies: { from: string; to: string }[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || copies.length === 0) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.copy.mutate({ remote, copies })
    await set(loadSnapshotAtom)
    await trpc.sync.commitNow.mutate()
  },
)

/**
 * A drop from Finder (`docs/features/file-tree.md`).
 *
 * A name the vault already uses is refused rather than overwritten, per file
 * rather than per drop. The skipped ones come back named, because a file that
 * silently did not arrive is the worst outcome here.
 */
export const importFilesAtom = atom(
  null,
  async (
    get,
    set,
    sources: string[],
    folder: string,
  ): Promise<{ name: string; reason: string }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote) return []
    const { skipped } = await trpc.notes.importFiles.mutate({ remote, sources, folder })
    await set(loadSnapshotAtom)
    return skipped
  },
)

/**
 * Vault content out to a folder on disk.
 *
 * Returns what LANDED as well as what failed: a move deletes only the targets
 * whose copy actually succeeded. No snapshot reload, since nothing in the vault
 * changed; a move reloads when its delete runs.
 */
export const exportFilesAtom = atom(
  null,
  async (
    get,
    _set,
    paths: string[],
    dest: string,
  ): Promise<{
    landed: { from: string; to: string }[]
    failed: { name: string; reason: string }[]
  }> => {
    const remote = get(activeRemoteAtom)
    if (!remote || paths.length === 0) return { landed: [], failed: [] }
    return trpc.notes.exportFiles.mutate({ remote, paths, dest })
  },
)

/**
 * Batch delete (file, folder, multi-selection). Clears the editor if the open
 * note is among them and closes every deleted tab. One commit-pair, like the
 * others. `folders` are what a folder delete was aimed at, pruned once their
 * documents are gone (`deleteMany` in main).
 */
export const deleteManyAtom = atom(
  null,
  async (get, set, { paths, folders = [] }: { paths: string[]; folders?: string[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || (paths.length === 0 && folders.length === 0)) return
    await flushAllBuffers()
    await trpc.sync.commitNow.mutate()
    await trpc.notes.deleteMany.mutate({ remote, paths, folders })
    const gone = new Set(paths)
    if (gone.has(get(activeDocAtom)?.path ?? '')) set(activeDocAtom, null)
    set(workspaceAtom, closeTabsForPaths(get(workspaceAtom), paths))
    await set(loadSnapshotAtom)
    await trpc.sync.commitNow.mutate()
  },
)

/** What links into a set: the folder / multi-selection delete preview. Empty,
 *  and no call, for an empty set. */
export const backrefsForMany = atom(
  null,
  async (get, _set, paths: string[]): Promise<{ path: string; count: number }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote || paths.length === 0) return []
    return trpc.notes.backrefsMany.query({ remote, paths })
  },
)
