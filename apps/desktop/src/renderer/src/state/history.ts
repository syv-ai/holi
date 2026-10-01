/**
 * Version history: the vault's git history, per open file and vault-wide.
 *
 * Git's object store IS the timeline (`docs/features/history.md`).
 * Everything per-file keys off the open note's **path**, and opening a different
 * note clears the selection and the preview.
 */
import { fileKind } from '@holi/shared'
import { atom } from 'jotai'
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import { fileHistoryAtom } from './file-history'
import { openSurface, workspaceAtom } from './panes'
import { activeRemoteAtom } from './vaults'

/** One commit that touched the open file: the git `Commit` shape. */
export interface Version {
  sha: string
  subject: string
  /** ISO 8601 author date. The panel formats it and never re-sorts: the log is
   *  already newest-first. */
  date: string
  author: string
  /** Lines added and removed, summed over the commit, or over the ONE file
   *  when this list is a note's own history. Both zero on a merge, which
   *  `--numstat` reports no diff for. */
  added: number
  removed: number
}

/**
 * The path the per-file history panel targets: the **focused tab**, when it is
 * a markdown file, a task included (not an image/pdf). Null otherwise, which
 * is also when the header History button hides.
 *
 * Keyed off the workspace's active tab, NOT `activeDocAtom`: that atom follows a
 * note being *opened*, not a tab being *focused*, so switching between open tabs
 * would leave the panel stale.
 */
export const historyTargetPathAtom = atom<string | null>((get) => {
  const w = get(workspaceAtom)
  const pane = w.panes[w.active]
  const tab = pane?.tabs[pane.active]
  if (!tab || tab.kind !== 'note') return null
  if (fileKind(tab.path) !== 'markdown') return null
  return tab.path
})

/** A file's before/after at a commit, fed to the merge view as a diff. */
export interface FileDiff {
  before: string
  after: string
}

export const historyOpenAtom = atom(false)

export const versionsAtom = atom<Version[]>([])
/**
 * How many commits touched the file, for the panel header. Not
 * `versions.length`: the list is capped (`HISTORY_LIMIT`). It is the frontmatter
 * header's `v.N`, read from the same `fileHistoryAtom`, so the two agree. Null
 * until it arrives.
 */
export const revisionCountAtom = atom<number | null>((get) => {
  const path = get(historyTargetPathAtom)
  if (path === null) return null
  const history = get(fileHistoryAtom(path))
  return history === undefined ? null : (history?.revisions ?? 0)
})
export const selectedShaAtom = atom<string | null>(null)
/** The selected commit's diff for the focused file, or null while none is picked
 *  / still loading. */
export const diffAtom = atom<FileDiff | null>(null)

// ------------------------------------------------------------------- write atoms

export const loadVersionsAtom = atom(null, async (get, set) => {
  const path = get(historyTargetPathAtom)
  if (!path) return
  const versions = await trpc.history.list.query({ path })
  // Focus may have moved to another file while this was in flight.
  if (get(historyTargetPathAtom) !== path) return
  set(versionsAtom, versions)
})

/** Load the diff a commit made to the focused file (vs its parent). */
export const loadDiffAtom = atom(null, async (get, set, sha: string) => {
  const path = get(historyTargetPathAtom)
  if (!path) return
  set(selectedShaAtom, sha)
  set(diffAtom, null)
  const diff = await trpc.history.fileDiff.query({ path, sha })
  // The file or the selection may have changed while this was in flight.
  if (get(selectedShaAtom) === sha && get(historyTargetPathAtom) === path) set(diffAtom, diff)
})

/**
 * Restore writes the old content back as a **new commit**, never a rewrite of
 * history. Flush the live buffer first so the editor's external-write reconcile
 * reloads the restored text cleanly (clean buffer → silent reload) rather than
 * 3-way-merging it. The list is refetched: the restore just minted a commit.
 */
export const restoreVersionAtom = atom(null, async (get, set, sha: string) => {
  const path = get(historyTargetPathAtom)
  const remote = get(activeRemoteAtom)
  if (!path || !remote) return
  await flushAllBuffers()
  await trpc.history.restore.mutate({ remote, path, sha })
  await set(loadVersionsAtom)
})

/** Opening a different note must not leave the last one's versions on screen. */
export const resetHistoryAtom = atom(null, (_get, set) => {
  set(versionsAtom, [])
  set(selectedShaAtom, null)
  set(diffAtom, null)
})

// -------------------------------------------------- the whole-vault history tab
// Every commit in the vault, and for the selected one every file it changed
// with its diff. Commit-first, where the panel above is file-first.
//
// **A diff per file, not one selected file.** Each changed file is its own
// collapsible, so several are on screen at once. Keyed by path within the
// commit, and dropped wholesale when the commit changes.

export const vaultCommitsAtom = atom<Version[]>([])
export const selectedCommitShaAtom = atom<string | null>(null)
export const commitFilesAtom = atom<string[]>([])
/** Path → diff, for the selected commit only. A path absent from it is one whose
 *  diff has not arrived yet. */
export const commitDiffsAtom = atom<Record<string, FileDiff>>({})

export const loadVaultLogAtom = atom(null, async (get, set) => {
  const commits = await trpc.history.log.query()
  set(vaultCommitsAtom, commits)
  // Opened on a commit: select it now the log holds it. One older than the
  // log reaches stays unselected rather than guessed at.
  const focus = get(historyFocusShaAtom)
  if (focus === null) return
  set(historyFocusShaAtom, null)
  const match = commitNamed(commits, focus)
  if (match !== undefined) await set(selectCommitAtom, match.sha)
})

/** One file's diff within the selected commit. Each collapsible asks for its
 *  own, so a commit touching thirty files fetches thirty times in parallel
 *  rather than serially through a selection. */
export const loadCommitDiffAtom = atom(null, async (get, set, path: string) => {
  const sha = get(selectedCommitShaAtom)
  if (sha === null) return
  const diff = await trpc.history.fileDiff.query({ path, sha })
  // The commit may have changed while this was in flight; its diffs are gone and
  // this one belongs to none of them.
  if (get(selectedCommitShaAtom) !== sha) return
  set(commitDiffsAtom, (byPath) => ({ ...byPath, [path]: diff }))
})

/** Pick a commit: list its files and drop the last commit's diffs. */
export const selectCommitAtom = atom(null, async (_get, set, sha: string) => {
  set(selectedCommitShaAtom, sha)
  set(commitFilesAtom, [])
  set(commitDiffsAtom, {})
  set(commitFilesAtom, await trpc.history.changed.query({ sha }))
})

/**
 * A commit to open the History view on, from somewhere else (an app's
 * approval names the commits its code came from). A History tab already open
 * selects it at once; one that is only now opening resets and reloads its log
 * as it mounts, so the load takes it from here once the log is in.
 */
const historyFocusShaAtom = atom<string | null>(null)

/** The commit whose sha is, or starts with, `sha`: a short hash names one. */
const commitNamed = (commits: readonly Version[], sha: string) =>
  commits.find((c) => c.sha === sha || c.sha.startsWith(sha))

export const openCommitInHistoryAtom = atom(null, (get, set, sha: string) => {
  const open = get(workspaceAtom).panes.some((p) =>
    p.tabs.some((t) => t.kind === 'surface' && t.surface === 'history'),
  )
  set(workspaceAtom, (w) => openSurface(w, 'history'))
  const match = open ? commitNamed(get(vaultCommitsAtom), sha) : undefined
  if (match !== undefined) void set(selectCommitAtom, match.sha)
  else set(historyFocusShaAtom, sha)
})

export const resetVaultLogAtom = atom(null, (_get, set) => {
  set(vaultCommitsAtom, [])
  set(selectedCommitShaAtom, null)
  set(commitFilesAtom, [])
  set(commitDiffsAtom, {})
})
