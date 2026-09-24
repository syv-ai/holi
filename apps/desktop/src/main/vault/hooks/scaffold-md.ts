/**
 * `scaffold-md` — a note gets its frontmatter however it arrived.
 *
 * Only one creation path used to scaffold: the file-tree `+`. An agent writing
 * a note through its own `Write`, a drag-and-drop import, a file made in another
 * editor in the same directory — all of them landed a `.md` with no `tags`, and until #17 that also cost the file its "N chars · Last
 * updated" bar, since the bar was the collapsed frontmatter widget.
 *
 * **Added files only, never modified ones.** That is the whole answer to the
 * question #17 raised about rewriting a note somebody else wrote: a file arriving
 * on `git pull` is committed by the pull and never appears in a staged set, and
 * one that has been in the vault for a year is `modified`, not `added`. What is
 * left is exactly the list the issue asked for — agent write, import, external
 * editor — all of which are creations, all of them local, and all of them ours to
 * shape.
 *
 * Which files count is `wantsScaffold` in `@holi/shared`, and it is the part
 * worth reading — `CLAUDE.md` is markdown too, and frontmatter there is prompt
 * text rather than metadata.
 *
 * **The window this leaves open, stated rather than hidden.** A transform
 * rewrites a file after the editor's save, which breaks the invariant
 * `editor-reload.ts` rests on, and unlike `normalize-md`'s tidy this one lands
 * on line 1. `decideReload` is not taught to recognise it, because a file in the
 * ADDED set is a file whose very first commit this is: the agent and the import
 * are not writing into something the user has open, and a note made with the
 * tree's `+` arrives already scaffolded and comes through here as a no-op. What
 * remains is someone creating a `.md` in another editor and typing into it in
 * Holi before the first autosave commit — where `merge3` handles a prepend
 * cleanly unless they are typing on line 1, and the conflict banner is the
 * result if they are.
 */
import { readFile } from 'node:fs/promises'
import { scaffoldFrontmatter, vaultRelPath, wantsScaffold } from '@holi/shared'
import { absPathFor, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

export async function scaffoldMd(
  root: string,
  staged: StagedChanges,
): Promise<TransformResult> {
  const changed: string[] = []

  for (const path of [...new Set(staged.added)].sort()) {
    if (!wantsScaffold(path)) continue
    const rel = vaultRelPath(path)
    const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
    if (text === null) continue

    const next = scaffoldFrontmatter(text)
    if (next === text) continue
    await writeAtomic(root, rel, next)
    changed.push(path)
  }

  return {
    changed,
    notes: changed.length === 0 ? [] : [`scaffold-md: added frontmatter to ${changed.length} file(s)`],
  }
}
