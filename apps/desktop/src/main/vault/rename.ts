/**
 * Rename is move plus link rewrite, as a helper both `notes.rename` and the
 * daily-note archive sweep call: there must be no second, bespoke
 * link-rewriting path.
 *
 * No existence check, no commit: callers own those. `notes.rename` refuses an
 * existing destination before calling; the sweep moves into a fresh `journal/`
 * path; both commit around it (the renderer for rename, one batched commit for
 * the sweep).
 */
import { isLocalOnlyPath, rewriteWikiLinks, vaultRelPath } from '@holi/shared'
import { scanBackrefs } from './backrefs'
import { isScratchpadPath } from './scratchpad'
import { oneMoveAtATime, relinkNote } from './move'
import { moveNoteComments } from './note-comments'
import { moveDocFile, withFileLocks } from './vault-files'

/** Move `from`→`to`, rewriting every inbound `[[link]]` in one pass. The rewrite
 *  runs before the move, so a mid-run failure leaves the source in place and
 *  visible in `git status` (there is no transaction). The note's comment
 *  threads move with it (`moveNoteComments`).
 *
 *  `localLinksOnly` rewrites only the links in this machine's local files: a
 *  file moving out of sync (a task made private) must not have every
 *  teammate's notes rewritten to point at a file they will never have. The
 *  committed notes keep the old path, which history still holds. */
export async function renameNote(
  root: string,
  from: string,
  to: string,
  { localLinksOnly = false }: { localLinksOnly?: boolean } = {},
): Promise<{ rewritten: { path: string; count: number }[] }> {
  return oneMoveAtATime(() => renameNow(root, from, to, localLinksOnly))
}

async function renameNow(
  root: string,
  from: string,
  to: string,
  localLinksOnly: boolean,
): Promise<{ rewritten: { path: string; count: number }[] }> {
  const referrers = (await scanBackrefs(root, from)).filter(
    (ref) => !isScratchpadPath(ref.path) && (!localLinksOnly || isLocalOnlyPath(ref.path)),
  )
  for (const ref of referrers) {
    await relinkNote(root, ref.path, (text) => rewriteWikiLinks(text, from, to))
  }
  // Under both names' locks, as every main-side writer takes a file: one
  // that checked the old name does not write it again beside the new.
  const names = [vaultRelPath(from), vaultRelPath(to)] as const
  await withFileLocks(root, names, () => moveDocFile(root, ...names))
  await moveNoteComments(root, [{ from, to }])
  return { rewritten: referrers }
}
