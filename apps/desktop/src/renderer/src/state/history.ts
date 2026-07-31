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
export const selectedShaAtom = atom<string | null>(null)
/** The selected commit's diff for the focused file, or null while none is picked
 *  / still loading. */
export const diffAtom = atom<FileDiff | null>(null)

// ------------------------------------------------------------------- write atoms

export const loadVersionsAtom = atom(null, async (get, set) => {
  const path = get(historyTargetPathAtom)
  if (!path) return
  const versions = await trpc.history.list.query({ path })
  // Focus may have moved to another file while this was in flight — don't stamp
  // one file's timeline over another's.
  if (get(historyTargetPathAtom) === path) set(versionsAtom, versions)
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
  set(selectedShaAtom, null)
  set(diffAtom, null)
})
