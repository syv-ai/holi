import { atom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { GITKEEP, type VaultEntry, type VaultSnapshot, emptyVaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import type { HeldBackFile } from '../../../main/vault/large-files'
import type { RendererPlugin } from '@/state/plugin-types'
import { flushAllBuffers, freezeBuffers } from '@/lib/buffer-registry'
import { flushSync } from 'react-dom'
import { shellWorkspaceAtom } from './shell-tabs'
import { retargetTabs as retargetShellTabs, closeTabsWhere } from './shell-workspace'
import { tabPath } from './tab-descriptor'
import { trpc } from '@/lib/trpc'
// A cycle (`plugins` reads `activeRemoteAtom`), safe because neither module
// reads the other's atoms until a store does.
import { openDocumentAtom } from './open-document'
// A cycle too (`document-runs` reads `activeRemoteAtom`), safe the same way.
import { documentRunsAtom } from './document-runs'
import { settledRect } from '@/lib/settled-rect'
import { folderSurfacesAtom } from './plugins'

type JotaiStore = ReturnType<typeof createStore>

export const vaultsAtom = atom<VaultEntry[]>([])

/** False until the first `loadVaults` resolves, so the App gate can tell an
 *  empty list (first run) apart from a not-yet-loaded one. */
export const vaultsLoadedAtom = atom(false)

const activeRemoteValueAtom = atom<string | null>(null)
const activeRemoteRevisionAtom = atom(0)

/** Changes on every actual active-vault transition, including A→B→A. */
export const activeRemoteRevisionValueAtom = atom((get) => get(activeRemoteRevisionAtom))

/** The open vault, as `owner/repo`. A vault has no id: the remote IS the
 * identity, and the clone's path is machine-local. The revision records every
 * actual selection change, including an A→B→A transition during async work. */
export const activeRemoteAtom = atom(
  (get) => get(activeRemoteValueAtom),
  (get, set, remote: string | null) => {
    if (get(activeRemoteValueAtom) === remote) return
    set(activeRemoteValueAtom, remote)
    set(activeRemoteRevisionAtom, (revision) => revision + 1)
    set(openedRemoteAtom, null)
    set(documentRunsAtom, {})
  },
)

/** The remote whose main-process `vaults.open` has completed. Plugin vault
 * hooks must not run until main has finished opening that vault. */
export const openedRemoteAtom = atom<string | null>(null)

/**
 * Per-vault "show hidden files" preference, persisted across launches. One
 * localStorage key holds a `{ [remote]: boolean }` map; a vault absent from it
 * defaults to hidden (`false`). Display-only: it gates the tree's `isHiddenPath`
 * filter and touches nothing about scanning, opening, or sync.
 */
export const showHiddenByVaultAtom = atomWithStorage<Record<string, boolean>>('holi:showHidden', {})

/** Per-vault "show task files in the tree" flag, off by default: the board owns
 * tasks. Purely a view filter; task files are always scanned into
 * `snapshot.claimed.tasks`. */
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

/** False until the open vault's first snapshot arrives: an empty vault and a
 *  loading one look alike otherwise. */
export const snapshotLoadedAtom = atom((get) => get(snapshotAtom) !== EMPTY_SNAPSHOT)

/**
 * The one sync state, exactly as main computed it.
 *
 * **Never re-derived here.** `computeState` in `active-vault.ts` fixes the
 * priority order (a pause outranks a conflict). `sync.state` is only the initial
 * read before the first push.
 */
export const syncStateAtom = atom<SyncState>({ kind: 'up-to-date' })

/** Files the large-file gate held out of the last commit, which the tree
 *  marks. Pushed from main every commit tick (empty clears it, incl. on a
 *  vault switch). */
export const heldBackAtom = atom<HeldBackFile[]>([])

/**
 * Settle a held-back file: commit it anyway (past the size gate), or keep it
 * on this machine (`.git/info/exclude`). Dropped from the list at once; main
 * pushes the accurate set on its next tick. Both are vault writes, so main
 * rescans and pushes the snapshot before answering: a file kept local arrives
 * dimmed.
 */
export const resolveHeldBackAtom = atom(
  null,
  async (get, set, { path, action }: { path: string; action: 'commit' | 'keep' }) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    if (action === 'commit') await trpc.vaults.commitFile.mutate({ remote, path })
    else await trpc.vaults.keepFileLocal.mutate({ remote, path })
    if (get(activeRemoteAtom) !== remote) return
    set(heldBackAtom, (files) => files.filter((file) => file.path !== path))
  },
)

/** The open vault's paths git ignores (`snapshot.ignored`), as a set: what
 *  never syncs from this machine, as main read it. Every vault's `.gitignore`
 *  carries the local-only lines (`LOCAL_ONLY_IGNORE_LINES`), so `.local.` and
 *  secret files are in it, and a local-named file someone committed anyway is
 *  rightly not. The tree dims these rows. */
export const ignoredPathsAtom = atom((get) => new Set(get(snapshotAtom).ignored))

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

/**
 * Bumps the epochs for one `onCommitted` push.
 * @public exported for its test
 */
export function bumpHistoryEpochs(epochs: HistoryEpochs, paths: string[] | null): HistoryEpochs {
  if (paths === null) return { ...epochs, all: epochs.all + 1 }
  const byPath = { ...epochs.byPath }
  for (const p of paths) byPath[p] = (byPath[p] ?? 0) + 1
  return { ...epochs, byPath }
}

/** A number that changes whenever `path`'s git history may have: a commit
 *  that took it, or anything under it when it is a folder (a vault app's
 *  bundle). */
export function historyEpoch(epochs: HistoryEpochs, path: string): number {
  const under = `${path}/`
  let n = epochs.all
  for (const [p, count] of Object.entries(epochs.byPath)) {
    if (p === path || p.startsWith(under)) n += count
  }
  return n
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
  const revision = get(activeRemoteRevisionAtom)
  const snapshot = await trpc.vaults.snapshot.query({ remote })
  if (get(activeRemoteAtom) === remote && get(activeRemoteRevisionAtom) === revision)
    set(snapshotAtom, snapshot)
})

/**
 * Open a vault: `vaults.open`, not `vaults.snapshot`. Opening is what *starts*
 * the watcher and the sync loop in main, and it hands back the live snapshot.
 *
 * A vault switch in main is a teardown: exactly one `ActiveVault` exists. Nothing
 * here may keep a snapshot keyed by remote.
 */
const openRequestAtom = atom(0)
const documentOpenIntentAtom = atom<{ id: number; remote: string } | null>(null)
const documentOpenIntentSequenceAtom = atom(0)

export const openVaultAtom = atom(
  null,
  async (
    get,
    set,
    target: string | { remote: string; documentIntentId?: number },
  ): Promise<boolean> => {
    const remote = typeof target === 'string' ? target : target.remote
    const documentIntentId = typeof target === 'string' ? undefined : target.documentIntentId
    const request = get(openRequestAtom) + 1
    set(openRequestAtom, request)
    const selectionRevision = get(activeRemoteRevisionAtom)

    // A cross-vault open (`onOpen` below) arrives with the old vault's editors
    // still mounted: what was typed goes into the vault it was typed in, before
    // that one closes. A switch from the vault menu flushed already
    // (`applyVaultSwitchAtom`), and this finds nothing left to write.
    await flushAllBuffers()
    // A newer selection or open request owns the main-process transition now.
    // Do not switch the renderer or clear per-vault state for a stale request.
    if (
      get(openRequestAtom) !== request ||
      get(activeRemoteRevisionAtom) !== selectionRevision ||
      (documentIntentId !== undefined && get(documentOpenIntentAtom)?.id !== documentIntentId)
    )
      return false

    const snapshot = await trpc.vaults.open.mutate({ remote })
    if (
      get(openRequestAtom) !== request ||
      get(activeRemoteRevisionAtom) !== selectionRevision ||
      (documentIntentId !== undefined && get(documentOpenIntentAtom)?.id !== documentIntentId)
    )
      return false

    // Publish the cross-vault document-open selection only after main has opened
    // it. This lets VaultHost observe openedRemote alongside activeRemote and
    // avoid starting a duplicate open for the same request.
    set(activeRemoteAtom, remote)
    set(snapshotAtom, snapshot)
    set(openedRemoteAtom, remote)
    return true
  },
)

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
  // The ritual opens over the old vault's editors, still mounted.
  await flushAllBuffers()
  const snapshot = await trpc.vaults.add.mutate({ remote })
  set(activeRemoteAtom, remote)
  set(snapshotAtom, snapshot)
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
  async (_get, _set, input: { name: string; owner: string }): Promise<string> => {
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
 *
 * Every installed plugin's events are subscribed, enabled or not: main sends
 * only for a vault that runs the plugin, and an event may be about a vault
 * other than the open one, whose settings the renderer has not read.
 */
export function subscribeToVault(
  store: JotaiStore,
  plugins: readonly RendererPlugin[] = [],
): () => void {
  const offSnapshot = window.holi.vault.onSnapshot((snapshot) => store.set(snapshotAtom, snapshot))
  const offSync = window.holi.vault.onSyncState((state) => store.set(syncStateAtom, state))
  const offHeldBack = window.holi.vault.onHeldBack((files) => store.set(heldBackAtom, files))
  const offCommitted = window.holi.vault.onCommitted((paths) =>
    store.set(historyEpochsAtom, (e) => bumpHistoryEpochs(e, paths)),
  )
  // Main asks for a path in a tab: a clicked reminder's task, `holi docs open`,
  // a Holi link. Cross-vault, the switch runs here, not in main, so
  // `activeRemoteAtom` stays truthful; the path opens once the new vault's
  // snapshot is in (`openVaultAtom` sets it before this resolves). A link's
  // heading is where the document's view puts the caret.
  const offReminder = window.holi.vault.onOpen(({ remote, path, heading }) => {
    const targetRemote = remote || store.get(activeRemoteAtom)
    if (!targetRemote) return
    const id = store.get(documentOpenIntentSequenceAtom) + 1
    store.set(documentOpenIntentSequenceAtom, id)
    store.set(documentOpenIntentAtom, { id, remote: targetRemote })

    if (targetRemote !== store.get(activeRemoteAtom)) {
      void store
        .set(openVaultAtom, { remote: targetRemote, documentIntentId: id })
        .then((landed) => {
          const latest = store.get(documentOpenIntentAtom)
          if (landed && latest?.id === id) {
            store.set(openDocumentAtom, path, heading)
          } else if (
            !landed &&
            latest?.remote === store.get(activeRemoteAtom) &&
            store.get(openedRemoteAtom) === store.get(activeRemoteAtom)
          ) {
            // A newer same-vault open superseded this request while main was
            // opening the other vault. Restore main to the still-active remote.
            void store.set(openVaultAtom, latest.remote)
          }
        })
    } else {
      store.set(openDocumentAtom, path, heading)
    }
  })
  // Main asks where a path's tab is drawn, for `holi docs screenshot`. It
  // opened the tab first, over `onOpen`, which arrives before this; a file's
  // tab is keyed by its path.
  const offLocate = window.holi.vault.onLocate(({ id, path }) => {
    settledRect(path).then(
      (rect) => window.holi.vault.located({ id, rect }),
      (err: unknown) => window.holi.vault.located({ id, error: (err as Error).message }),
    )
  })
  const tables = plugins.flatMap((p) =>
    p.events === undefined ? [] : [[p.info.id, p.events] as const],
  )
  const offEvents = tables.map(([id, handlers]) =>
    window.holi.plugin.on(id, ({ remote, name, payload }) => {
      if (Object.hasOwn(handlers, name)) handlers[name]!({ remote, payload }, store)
    }),
  )
  return () => {
    offSnapshot()
    offSync()
    offHeldBack()
    offCommitted()
    offReminder()
    offLocate()
    offEvents.forEach((off) => off())
  }
}

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  // Created empty, a note included: its frontmatter bar opens to empty rows,
  // and the block is written with the first value.
  await trpc.notes.create.mutate({ remote, path, text: '' })
  await set(loadSnapshotAtom)
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

/**
 * "Try again" on a sticky conflict: main clears it, commits and pulls. A
 * conflict that is still real latches again, so the banner comes back.
 */
export const retrySyncAtom = atom(null, async () => {
  await trpc.sync.retry.mutate()
})

/**
 * Switch the vault to a branch, or create one at HEAD (the status bar's branch
 * picker, `docs/features/status-bar.md`).
 *
 * The buffers go to disk first, so the settle commit main makes before the
 * switch carries the newest words onto the branch they were typed on. Main
 * refuses, in words, whatever would lose work; the rejection is the caller's to
 * show. Afterwards the snapshot is read again at once rather than waiting for
 * the watcher, and open editors reload from the new tree as after a pull.
 */
export const switchBranchAtom = atom(
  null,
  async (_get, set, { name, create = false }: { name: string; create?: boolean }) => {
    const release = freezeBuffers()
    try {
      await flushAllBuffers()
      await trpc.sync.switchBranch.mutate({ name, create })
      await set(loadSnapshotAtom)
    } finally {
      release()
    }
  },
)

/**
 * The restore point a multi-file edit starts from: the buffers on disk, then
 * a commit. Callers then freeze editors and flush again, so edits typed
 * during this commit are saved before the files move.
 */
async function restorePoint(): Promise<void> {
  await flushAllBuffers()
  await trpc.sync.commitNow.mutate()
}

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
  async (
    get,
    set,
    {
      from,
      to,
      localLinksOnly,
    }: {
      from: string
      to: string
      /** Rewrite only the links in this machine's local files: a task made
       *  private, whose shared notes must not be committed pointing at it. */
      localLinksOnly?: boolean
    },
  ) => {
    const remote = get(activeRemoteAtom)
    if (!remote) return
    await restorePoint()
    const release = freezeBuffers()
    try {
      await flushAllBuffers()
      await trpc.notes.rename.mutate({
        remote,
        from,
        to,
        ...(localLinksOnly === true ? { localLinksOnly } : {}),
      })
      flushSync(() => {
        set(shellWorkspaceAtom, (ws) =>
          retargetShellTabs(ws, [{ from, to }], get(folderSurfacesAtom)),
        )
      })
      await set(loadSnapshotAtom)
      await trpc.sync.commitNow.mutate()
    } finally {
      release()
    }
  },
)

/**
 * Batch move (folder rename/delete-to-move, drag, cut+paste). Same order as
 * `renameNoteAtom`, one commit-pair for the whole batch: flush the live buffer
 * and commit a clean restore point, run the single-pass `notes.move`, reload
 * the snapshot, commit again. The open tabs follow
 * through the caller (`onMoved`).
 * `folders` are the folders the move was aimed at, whose leftovers (`.gitkeep`,
 * ignored files) main carries after the documents.
 */
export const moveNotesAtom = atom(
  null,
  async (
    get,
    set,
    {
      moves,
      folders = [],
    }: { moves: { from: string; to: string }[]; folders?: { from: string; to: string }[] },
  ) => {
    const remote = get(activeRemoteAtom)
    if (!remote || (moves.length === 0 && folders.length === 0)) return
    await restorePoint()
    const release = freezeBuffers()
    try {
      await flushAllBuffers()
      await trpc.notes.move.mutate({ remote, moves, folders })
      flushSync(() => {
        set(shellWorkspaceAtom, (ws) => retargetShellTabs(ws, moves, get(folderSurfacesAtom)))
      })
      await set(loadSnapshotAtom)
      await trpc.sync.commitNow.mutate()
    } finally {
      release()
    }
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
 * Batch delete (file, folder, multi-selection). Clears the editor if the open
 * note is among them; the caller closes the deleted tabs. One commit-pair, like the
 * others. `folders` are what a folder delete was aimed at, pruned once their
 * documents are gone (`deleteMany` in main).
 */
export const deleteManyAtom = atom(
  null,
  async (get, set, { paths, folders = [] }: { paths: string[]; folders?: string[] }) => {
    const remote = get(activeRemoteAtom)
    if (!remote || (paths.length === 0 && folders.length === 0)) return
    await restorePoint()
    const release = freezeBuffers()
    try {
      await flushAllBuffers()
      await trpc.notes.deleteMany.mutate({ remote, paths, folders })
      const gone = new Set(paths)
      flushSync(() => {
        set(shellWorkspaceAtom, (ws) => closeTabsWhere(ws, (key) => gone.has(tabPath(key) ?? '')))
      })
      await set(loadSnapshotAtom)
      await trpc.sync.commitNow.mutate()
    } finally {
      release()
    }
  },
)
