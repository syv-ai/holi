/**
 * `scaffold-md`: a note gets its frontmatter however it arrived (agent `Write`,
 * import, another editor), not only via the file-tree `+`.
 *
 * **Added files only, never modified ones.** A pulled file is committed by the
 * pull and never staged here, and an old note is `modified`, so only local
 * creations are shaped. Which files count is `wantsScaffold` in `@holi/shared`:
 * frontmatter in `CLAUDE.md` would be prompt text, not metadata. A file a
 * plugin claims (a task) is skipped too: its plugin owns its frontmatter, and
 * a second writer would fight it every commit.
 *
 * **The window this leaves open.** The prepend lands after the editor's save,
 * which `editor-reload.ts`'s `decideReload` does not recognise. That only bites
 * someone typing in Holi into a `.md` made elsewhere before its first commit:
 * `merge3` handles the prepend unless they are on line 1, where the conflict
 * banner shows.
 */
import { readFile } from 'node:fs/promises'
import {
  scaffoldFrontmatter,
  vaultRelPath,
  wantsScaffold,
  type SnapshotClaim,
} from '@holi/shared'
import { absPathFor, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

export async function scaffoldMd(
  root: string,
  staged: StagedChanges,
  claims: readonly Pick<SnapshotClaim, 'match'>[],
): Promise<TransformResult> {
  const changed: string[] = []

  for (const path of [...new Set(staged.added)].sort()) {
    if (!wantsScaffold(path) || claims.some((c) => c.match(path))) continue
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
