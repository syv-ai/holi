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
import { readFile } from 'node:fs/promises'
import { isLocalOnlyPath, rewriteWikiLinks, vaultRelPath } from '@holi/shared'
import { scanBackrefs } from './backrefs'
import { moveNoteComments } from './note-comments'
import { absPathFor, moveDocFile, writeAtomic } from './vault-files'

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
  const referrers = (await scanBackrefs(root, from)).filter(
    (ref) => !localLinksOnly || isLocalOnlyPath(ref.path),
  )
  for (const ref of referrers) {
    const rel = vaultRelPath(ref.path)
    const text = await readFile(absPathFor(root, rel), 'utf8')
    const { text: rewritten } = rewriteWikiLinks(text, from, to)
    await writeAtomic(root, rel, rewritten)
  }
  await moveDocFile(root, vaultRelPath(from), vaultRelPath(to))
  await moveNoteComments(root, [{ from, to }])
  return { rewritten: referrers }
}
