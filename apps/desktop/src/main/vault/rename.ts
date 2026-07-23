/**
 * Rename-is-move-plus-link-rewrite (notes-editor FR-11), as a helper both
 * `notes.rename` and the daily-note archive sweep call — the archive move is a
 * rename, and there must be no second, bespoke link-rewriting path
 * (`daily-notes.md` §Archiving).
 *
 * No existence check, no commit: callers own those. `notes.rename` refuses an
 * existing destination before calling; the sweep moves into a fresh `journal/`
 * path; both commit around it (the renderer for rename, one batched commit for
 * the sweep).
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinks, vaultRelPath } from '@holi/shared'
import { scanBackrefs } from './backrefs'
import { absPathFor, moveDocFile, writeAtomic } from './vault-files'

/** Move `from`→`to`, rewriting every inbound `[[link]]` in one pass. The rewrite
 *  runs before the move, so a mid-run failure leaves the source in place and
 *  visible in `git status` (there is no transaction — prd §Rename). */
export async function renameNote(
  root: string,
  from: string,
  to: string,
): Promise<{ rewritten: { path: string; count: number }[] }> {
  const referrers = await scanBackrefs(root, from)
  for (const ref of referrers) {
    const rel = vaultRelPath(ref.path)
    const text = await readFile(absPathFor(root, rel), 'utf8')
    const { text: rewritten } = rewriteWikiLinks(text, from, to)
    await writeAtomic(root, rel, rewritten)
  }
  await moveDocFile(root, vaultRelPath(from), vaultRelPath(to))
  return { rewritten: referrers }
}
