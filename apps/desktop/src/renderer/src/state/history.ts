/**
 * Version history: the vault's git history, per open file and vault-wide.
 *
 * Git's object store IS the timeline (`docs/features/history.md`).
 * Everything per-file keys off the open note's **path**, and opening a different
 * note clears the selection and the preview.
 */
import { fileKind } from '@holi/shared'
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { openSurface, workspaceAtom } from './panes'

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
 * @public exported for its test
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
interface FileDiff {
  before: string
  after: string
}

// -------------------------------------------------- the whole-vault history tab
// Every commit in the vault, and for the selected one every file it changed
// with its diff. Commit-first, where the panel above is file-first.
//
// **A diff per file, not one selected file.** Each changed file is its own
// collapsible, so several are on screen at once. Keyed by path within the
// commit, and dropped wholesale when the commit changes.

const vaultCommitsAtom = atom<Version[]>([])
const selectedCommitShaAtom = atom<string | null>(null)
const commitFilesAtom = atom<string[]>([])
/** Path → diff, for the selected commit only. A path absent from it is one whose
 *  diff has not arrived yet. */
const commitDiffsAtom = atom<Record<string, FileDiff>>({})

/** Pick a commit: list its files and drop the last commit's diffs. */
const selectCommitAtom = atom(null, async (_get, set, sha: string) => {
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
