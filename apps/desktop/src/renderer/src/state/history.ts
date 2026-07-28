/**
 * Version history — the vault's git history, per open file.
 *
 * D60 deleted the CRDT snapshot store; git's object store IS the timeline
 * (`prd/vaults-sync.md` §History). Everything here keys off the open note's
 * **path** — a `DocMeta` has no id under D60 — and opening a different note
 * clears the selection and the preview.
 */
import { atom } from 'jotai'
import { flushAllBuffers } from '../lib/buffer-registry'
import { trpc } from '../lib/trpc'
import { activeDocAtom, activeRemoteAtom } from './vaults'

/** One commit that touched the open file — the git `Commit` shape. */
export interface Version {
  sha: string
  subject: string
  /** ISO 8601 author date. The panel formats it and never re-sorts — the log is
   *  already newest-first. */
  date: string
  author: string
}

export const historyOpenAtom = atom(false)
export const versionsAtom = atom<Version[]>([])
export const selectedShaAtom = atom<string | null>(null)
export const previewAtom = atom<string | null>(null)
/** Display-only fold of the autosave run; the landmarks always show. */
export const showAllVersionsAtom = atom(false)

// ------------------------------------------------------------------ reducers
// Pure, exported, and tested directly — the atoms are just where they live.

/**
 * Split the timeline into landmarks and the autosave run (`prd/vaults-sync.md`
 * §History, "milestones fall out for free").
 *
 * Autosave commits are `Update <path>` / `Update N files` (see `commitMessage` in
 * `active-vault`); everything else — merges, reconciles, and any deliberately-
 * authored commit (the agent's, the seed) — is a landmark worth surfacing above
 * the wall of autosaves. A push leaves no commit, so it is never in here.
 */
export function partitionVersions(rows: Version[]): {
  landmarks: Version[]
  automatic: Version[]
} {
  const isAutosave = (v: Version) => /^Update /.test(v.subject)
  return {
    landmarks: rows.filter((v) => !isAutosave(v)),
    automatic: rows.filter(isAutosave),
  }
}

/** What to call a version — its commit subject, never empty. */
export function versionLabel(v: Version): string {
  return v.subject.trim() || 'version'
}

// ------------------------------------------------------------------- write atoms

export const loadVersionsAtom = atom(null, async (get, set) => {
  const doc = get(activeDocAtom)
  if (!doc) return
  set(versionsAtom, await trpc.history.list.query({ path: doc.path }))
})

export const loadPreviewAtom = atom(null, async (get, set, sha: string) => {
  const doc = get(activeDocAtom)
  if (!doc) return
  set(selectedShaAtom, sha)
  set(previewAtom, null)
  const { text } = await trpc.history.preview.query({ path: doc.path, sha })
  // The note may have closed, or another version been picked, while this was in flight.
  if (get(selectedShaAtom) === sha) set(previewAtom, text)
})

/**
 * Restore writes the old content back as a **new commit** — never a rewrite of
 * history. Flush the live buffer first so the editor's external-write reconcile
 * reloads the restored text cleanly (clean buffer → silent reload) rather than
 * 3-way-merging it. The list is refetched — the restore just minted a commit, and
 * a timeline missing it is missing it at the one moment it matters.
 */
export const restoreVersionAtom = atom(null, async (get, set, sha: string) => {
  const doc = get(activeDocAtom)
  const remote = get(activeRemoteAtom)
  if (!doc || !remote) return
  await flushAllBuffers()
  await trpc.history.restore.mutate({ remote, path: doc.path, sha })
  await set(loadVersionsAtom)
})

/** Opening a different note must not leave the last one's versions on screen. */
export const resetHistoryAtom = atom(null, (_get, set) => {
  set(versionsAtom, [])
  set(selectedShaAtom, null)
  set(previewAtom, null)
  set(showAllVersionsAtom, false)
})
