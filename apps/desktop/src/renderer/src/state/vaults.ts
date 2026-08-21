import { atom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { GITKEEP, type DocMeta, type VaultEntry, type VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import type { HeldBackFile } from '../../../main/vault/large-files'
import { flushAllBuffers } from '../lib/buffer-registry'
import { buildReconcilePrompt } from '../lib/reconcile-prompt'
import { scaffoldNoteText } from '../lib/scaffold'
import { trpc } from '../lib/trpc'
import { agentPanelOpenAtom, agentSeedPromptAtom } from './agent'
import { closeTabsForPaths, openApp, retargetTab, retargetTabs, workspaceAtom } from './panes'
import { openTaskAtom } from './view'

type JotaiStore = ReturnType<typeof createStore>

export const vaultsAtom = atom<VaultEntry[]>([])

/** False until the first `loadVaults` resolves, so the App gate can tell an
 *  empty list (first run) apart from a not-yet-loaded one. */
export const vaultsLoadedAtom = atom(false)

/** The open vault, as `owner/repo`. A vault has no id — the remote IS the
 * identity, and the clone's path is machine-local (types.ts §VaultEntry). */
export const activeRemoteAtom = atom<string | null>(null)

/**
 * Per-vault "show hidden files" preference, persisted across launches. One
 * localStorage key holds a `{ [remote]: boolean }` map; a vault absent from it
 * defaults to hidden (`false`). Display-only — it gates the tree's `isHiddenPath`
 * filter and touches nothing about scanning, opening, or sync.
 */
export const showHiddenByVaultAtom = atomWithStorage<Record<string, boolean>>('holi:showHidden', {})

/** Per-vault "show task files in the tree" flag, off by default — the board owns
 * tasks, so the tree stays notes-only until you opt a vault in. Purely a view
 * filter: task files are always scanned into `snapshot.tasks`; this only decides
 * whether they also render as leaves in the file tree (with a task glyph). */
export const showTasksByVaultAtom = atomWithStorage<Record<string, boolean>>('holi:showTasks', {})

const EMPTY_SNAPSHOT: VaultSnapshot = { docs: [], tasks: [], broken: [], files: [], dirs: [] }

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

/** Files the large-file gate held out of the last commit — the callout's source.
 *  Pushed from main every commit tick (empty clears it, incl. on a vault switch). */
export const heldBackAtom = atom<HeldBackFile[]>([])

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
 * vault that exists only locally is not one anybody can be invited to. So by the
 * time this resolves the repo genuinely exists on GitHub and is clonable — which
 * is what lets the ritual's threshold say so truthfully.
 *
 * **Deliberately does NOT refresh the vault list.** The onboarding ritual shows
 * a "created — here's the remote" step *before* entering, and the first-run gate
 * flips to the Shell the moment `vaultsAtom` becomes non-empty. So loading the
 * list here would unmount the ritual mid-success; the explicit `loadVaults` on
 * "Open vault" is what enters. The active remote + snapshot are set now so that
 * entry is instant.
 *
 * **`owner` is required here even though the router makes it optional.**
 * `vaults.create` answers with a snapshot rather than the repo, so the only way
 * the renderer can name the vault it just made is by knowing the owner up
 * front — and defaulting to the signed-in account would mean *guessing* the
 * remote and opening the wrong one. The UI always has a login to supply.
 *
 * Returns the `owner/repo` remote so the caller can show it without re-deriving.
 */
export const createVaultAtom = atom(
  null,
  async (_get, set, input: { name: string; owner: string }): Promise<string> => {
    const snapshot = await trpc.vaults.create.mutate(input)
    const remote = `${input.owner}/${input.name}`
    set(activeRemoteAtom, remote)
    set(snapshotAtom, snapshot)
    set(activeDocAtom, null)
    return remote
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
  const offHeldBack = window.holi.vault.onHeldBack((files) => store.set(heldBackAtom, files))
  // A clicked reminder opens its task. Cross-vault, the switch runs here — not in
  // main — so `activeRemoteAtom` stays truthful; the task opens once the new
  // vault's snapshot is in (`openVaultAtom` sets it before this resolves).
  const offReminder = window.holi.reminders.onOpen(({ remote, path }) => {
    if (remote && remote !== store.get(activeRemoteAtom)) {
      void store.set(openVaultAtom, remote).then(() => store.set(openTaskAtom, path))
    } else {
      store.set(openTaskAtom, path)
    }
  })
  // `holi app open <id>`, typed by the agent. Local authorship only — see the
  // channel's own comment for why an app appearing in the snapshot does not
  // open anything.
  const offAppOpen = window.holi.apps.onOpen((appId) => {
    store.set(workspaceAtom, (w) => openApp(w, appId))
  })
  return () => {
    offSnapshot()
    offSync()
    offHeldBack()
    offReminder()
    offAppOpen()
  }
}

export const createNoteAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  // A markdown note opens with starter frontmatter (title + created) so the
  // metadata is there from the start; any other file type is created empty — a
  // note-scaffold in a .json would be nonsense (spec §Arbitrary files). Local
  // date, to match how the daily note is dated.
  const isoDate = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local
  const text = path.endsWith('.md') ? scaffoldNoteText(isoDate) : ''
  await trpc.notes.create.mutate({ remote, path, text })
  await set(loadSnapshotAtom)
  set(activeDocAtom, get(snapshotAtom).docs.find((d) => d.path === path) ?? null)
})

/** Make a folder real on disk. Git tracks no empty directory, so we drop a
 *  `.gitkeep` inside it — the scanner then surfaces the folder in `snapshot.dirs`
 *  (the keep-file itself is never shown), and an empty folder survives a clone.
 *  `notes.write` upserts, so re-creating an existing folder is a harmless no-op. */
export const createFolderAtom = atom(null, async (get, set, path: string) => {
  const remote = get(activeRemoteAtom)
  if (!remote) return
  await trpc.notes.write.mutate({ remote, path: `${path}/${GITKEEP}`, text: '' })
  await set(loadSnapshotAtom)
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
/**
 * "Ask Claude to reconcile" (FR-18). Re-materialise the conflict in the working
 * tree (main re-runs the merge), then open the drawer and seed the agent's first
 * turn with the conflicted paths. If the merge now applies cleanly (no paths),
 * the banner is already cleared and there is nothing to hand the agent.
 */
export const reconcileAtom = atom(null, async (_get, set) => {
  const { paths } = await trpc.sync.reconcile.mutate()
  if (paths.length === 0) return
  set(agentSeedPromptAtom, buildReconcilePrompt(paths))
  set(agentPanelOpenAtom, true)
})

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
 * Batch copy (Duplicate, Copy+Paste). No link rewrite and no tab retarget — the
 * originals stay put — but the same commit-pair ordering, and the flush ensures a
 * copy of a note being edited includes the latest keystrokes.
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
 * Batch delete (file, folder, multi-selection). Clears the editor if the open
 * note is among them and closes every deleted tab, so the pane never holds a doc
 * that no longer exists. One commit-pair, like the others.
 */
export const deleteManyAtom = atom(null, async (get, set, { paths }: { paths: string[] }) => {
  const remote = get(activeRemoteAtom)
  if (!remote || paths.length === 0) return
  await flushAllBuffers()
  await trpc.sync.commitNow.mutate()
  await trpc.notes.deleteMany.mutate({ remote, paths })
  const gone = new Set(paths)
  if (gone.has(get(activeDocAtom)?.path ?? '')) set(activeDocAtom, null)
  set(workspaceAtom, closeTabsForPaths(get(workspaceAtom), paths))
  await set(loadSnapshotAtom)
  await trpc.sync.commitNow.mutate()
})

/** What links into a set — the folder / multi-selection delete preview (FR-12
 *  generalized). Empty, and no call, for an empty set. */
export const backrefsForMany = atom(
  null,
  async (get, _set, paths: string[]): Promise<{ path: string; count: number }[]> => {
    const remote = get(activeRemoteAtom)
    if (!remote || paths.length === 0) return []
    return trpc.notes.backrefsMany.query({ remote, paths })
  },
)
