/**
 * Version history — the vault's git history, per open file.
 *
 * D60 deleted the CRDT snapshot store; git's object store IS the timeline
 * (`prd/vaults-sync.md` §History). Everything here keys off the open note's
 * **path** — a `DocMeta` has no id under D60 — and opening a different note
 * clears the selection and the preview.
 */
import { fileKind, isTaskFilePath } from '@holi/shared'
import { atom } from 'jotai'
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import { workspaceAtom } from './panes'
import { activeRemoteAtom } from './vaults'

/** One commit that touched the open file — the git `Commit` shape. */
export interface Version {
  sha: string
  subject: string
  /** ISO 8601 author date. The panel formats it and never re-sorts — the log is
   *  already newest-first. */
  date: string
  author: string
  /** Lines added and removed, summed over the commit — or over the ONE file
   *  when this list is a note's own history, which is the more useful number
   *  there. Both zero on a merge, which `--numstat` reports no diff for. */
  added: number
  removed: number
}

/**
 * The path the history drawer targets: the **focused tab**, when it is a markdown
 * note (not a task file, not an image/pdf). Null otherwise — which is also when
 * the header History button hides.
 *
 * Keyed off the workspace's active tab, NOT `activeDocAtom`: that atom follows a
 * note being *opened* (a tree click / wiki-link), not a tab being *focused*, and
 * `EditorPane` never syncs it — so switching between open tabs would leave the
 * drawer stale. One source of truth, shared by the button and the drawer.
 */
export const historyTargetPathAtom = atom<string | null>((get) => {
  const w = get(workspaceAtom)
  const pane = w.panes[w.active]
  const tab = pane?.tabs[pane.active]
  if (!tab || tab.kind !== 'note') return null
  if (fileKind(tab.path) !== 'markdown' || isTaskFilePath(tab.path)) return null
  return tab.path
})

/** A file's before/after at a commit — fed to the merge view as a diff. */
export interface FileDiff {
  before: string
  after: string
}

export const historyOpenAtom = atom(false)
export const versionsAtom = atom<Version[]>([])
/**
 * How many commits touched the file, for the panel header. Not
 * `versions.length`: the list is capped (`HISTORY_LIMIT`), and this is the same
 * uncapped count the frontmatter header's `v.N` shows, so the two agree. Null
 * until it arrives.
 */
export const revisionCountAtom = atom<number | null>(null)
export const selectedShaAtom = atom<string | null>(null)
/** The selected commit's diff for the focused file, or null while none is picked
 *  / still loading. */
export const diffAtom = atom<FileDiff | null>(null)

// ------------------------------------------------------------------- write atoms

export const loadVersionsAtom = atom(null, async (get, set) => {
  const path = get(historyTargetPathAtom)
  if (!path) return
  const [versions, history] = await Promise.all([
    trpc.history.list.query({ path }),
    trpc.notes.fileHistory.query({ path }).catch(() => undefined),
  ])
  // Focus may have moved to another file while this was in flight — don't stamp
  // one file's timeline over another's.
  if (get(historyTargetPathAtom) !== path) return
  set(versionsAtom, versions)
  if (history !== undefined) set(revisionCountAtom, history?.revisions ?? 0)
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
 * Restore writes the old content back as a **new commit** — never a rewrite of
 * history. Flush the live buffer first so the editor's external-write reconcile
 * reloads the restored text cleanly (clean buffer → silent reload) rather than
 * 3-way-merging it. The list is refetched — the restore just minted a commit, and
 * a timeline missing it is missing it at the one moment it matters.
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
  set(revisionCountAtom, null)
  set(selectedShaAtom, null)
  set(diffAtom, null)
})

// -------------------------------------------------- the whole-vault history tab
// The broad history surface (a tab, opened from the footer sync state): every
// commit in the vault, and for the selected one every file it changed with its
// diff. Commit-first, where the drawer above is file-first.
//
// **A diff per file, not one selected file.** The surface shows each changed
// file as its own collapsible with the diff inside it, so several are on screen
// at once and each is loaded and kept on its own. Keyed by path within the
// commit, and dropped wholesale when the commit changes.

export const vaultCommitsAtom = atom<Version[]>([])
export const selectedCommitShaAtom = atom<string | null>(null)
export const commitFilesAtom = atom<string[]>([])
/** Path → diff, for the selected commit only. A path absent from it is one whose
 *  diff has not arrived yet. */
export const commitDiffsAtom = atom<Record<string, FileDiff>>({})

export const loadVaultLogAtom = atom(null, async (_get, set) => {
  set(vaultCommitsAtom, await trpc.history.log.query())
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

export const resetVaultLogAtom = atom(null, (_get, set) => {
  set(vaultCommitsAtom, [])
  set(selectedCommitShaAtom, null)
  set(commitFilesAtom, [])
  set(commitDiffsAtom, {})
})
