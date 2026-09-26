/**
 * `relink`: rewrite inbound `[[links]]` for a file that moved outside Holi
 * (a `git mv`, or the agent's own move), so links never dangle silently.
 *
 * **It does not move anything.** Git already did. `moveNotes` shares the
 * rewrite and owns the move.
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'

export interface TransformResult {
  /** Vault-relative paths this transform rewrote, sorted. */
  changed: string[]
  /** Lines for the run log: what it did, and anything it declined to do. */
  notes: string[]
}

export async function relink(root: string, staged: StagedChanges): Promise<TransformResult> {
  // No renames means nothing to do, and it must cost nothing: this runs on
  // every commit, and most commits are edits.
  if (staged.renamed.length === 0) return { changed: [], notes: [] }

  /**
   * One map, one pass over the ORIGINAL text. Under `a→b` and `b→c` in the same
   * commit, `[[a.md]]` must become `b.md` and **stop**; sequential single-target
   * rewrites would chain it on to `c.md`.
   */
  const map = new Map(staged.renamed.map((r) => [r.from, r.to]))
  const changed: string[] = []

  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md')) continue
    const rel = vaultRelPath(path)
    const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
    if (text === null) continue

    const { text: next, count } = rewriteWikiLinksMulti(text, map)
    if (count === 0) continue
    await writeAtomic(root, rel, next)
    changed.push(path)
  }

  changed.sort()
  const notes =
    changed.length === 0
      ? [`relink: ${map.size} rename(s), no inbound links to fix`]
      : [`relink: rewrote links in ${changed.length} file(s) for ${map.size} rename(s)`]
  return { changed, notes }
}
