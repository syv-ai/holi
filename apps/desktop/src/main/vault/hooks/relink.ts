/**
 * `relink` — rewrite inbound `[[links]]` for a file that moved outside Holi.
 *
 * `AGENTS.md` used to tell the agent to grep for `[[<path>` and rewrite by hand
 * before moving a file. That instruction is followed inconsistently and fails
 * silently: the move succeeds, the links dangle, and nobody finds out until a
 * tombstone appears in a note weeks later. This makes the vault's own commit do
 * it, for a `git mv` in a terminal as much as for the agent's own move.
 *
 * **It does not move anything.** Git already did; only inbound links need
 * fixing. That is the whole difference between this and `moveNotes`, which
 * shares the rewrite and owns the move.
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'

export interface TransformResult {
  /** Vault-relative paths this transform rewrote, sorted. */
  changed: string[]
  /** Lines for the run log — what it did, and anything it declined to do. */
  notes: string[]
}

export async function relink(root: string, staged: StagedChanges): Promise<TransformResult> {
  // No renames means nothing to do, and it must cost nothing: this runs on
  // every commit, and most commits are edits.
  if (staged.renamed.length === 0) return { changed: [], notes: [] }

  /**
   * One map, one pass over the ORIGINAL text — the primitive `moveNotes`
   * already uses, and for its reason. Under `a→b` and `b→c` in the same commit,
   * a link `[[a.md]]` must resolve to `b.md` and **stop**. Applying N
   * single-target rewrites in sequence chains it on to `c.md`, which is a
   * double-rewrite that looks correct in every test with one rename in it.
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
