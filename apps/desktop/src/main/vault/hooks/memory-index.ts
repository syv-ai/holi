/**
 * `memory-index` — `memory/index.md` lands in the same commit as the memory it
 * describes (D89).
 *
 * **Why the commit boundary, given it does not need a rename map.** `relink`
 * lives here because `git diff --cached -M` is the only place a rename's
 * `from → to` pairing exists; an index regenerated from the tree needs no such
 * thing. It is here for the other two reasons:
 *
 * - **The restage.** The index must be part of the *same* commit as the memory
 *   file. Anywhere else and every commit is followed by an index commit, forever.
 * - **Coalescing.** A burst of memory writes in one agent turn produces one
 *   commit with its index already correct, rather than N commits of index churn
 *   pushed to every member.
 *
 * **Gated on the diff, but indexed from the tree.** `StagedChanges` decides
 * *whether* to run — this fires on every commit and most commits are edits, so
 * the common path has to cost nothing. `listFiles` then decides *what* goes in,
 * because indexing from the diff alone would drop every memory an unrelated
 * commit did not happen to touch.
 *
 * **It cannot block a commit** (FR-9). The runner catches, logs and lets the
 * commit through; three consecutive failures sit it out for the session. Holi's
 * auto-commit IS the user's save, and an index is an opinion about tidiness.
 */
import { readFile } from 'node:fs/promises'
import {
  MEMORY_INDEX,
  isSharedMemoryPath,
  readMemoryEntry,
  renderMemoryIndex,
  vaultRelPath,
  type MemoryEntry,
} from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

/**
 * Whether this commit touches a memory the index would list.
 *
 * A personal `.local.md` is deliberately not one: it never appears in the
 * index, so a commit that could only contain one has nothing to regenerate for.
 *
 * **`deleted` matters here and nowhere else in the hook set.** The other four
 * transforms rewrite the changed file itself, so a file going away is nothing
 * to them; this one's output is a list of what EXISTS, and a deletion that did
 * not re-index would leave `memory/index.md` naming a file that is gone. It is
 * why `StagedChanges` carries deletions at all.
 */
function touchesSharedMemory(staged: StagedChanges): boolean {
  return (
    staged.added.some(isSharedMemoryPath) ||
    staged.modified.some(isSharedMemoryPath) ||
    staged.deleted.some(isSharedMemoryPath) ||
    staged.renamed.some((r) => isSharedMemoryPath(r.from) || isSharedMemoryPath(r.to))
  )
}

export async function memoryIndex(root: string, staged: StagedChanges): Promise<TransformResult> {
  if (!touchesSharedMemory(staged)) return { changed: [], notes: [] }

  const entries: MemoryEntry[] = []
  for (const path of await listFiles(root)) {
    if (!isSharedMemoryPath(path)) continue
    // A memory deleted between `listFiles` and this read is ordinary, not an
    // error: the commit being made may be the one deleting it.
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8').catch(() => null)
    if (text === null) continue
    entries.push(readMemoryEntry(path, text))
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const next = renderMemoryIndex(entries)
  const rel = vaultRelPath(MEMORY_INDEX)
  const current = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)

  // **Only when it differs.** A `changed` entry the runner dutifully restages
  // for a file nothing rewrote is an empty commit, on every memory edit that
  // did not move a title.
  if (current === next) {
    return {
      changed: [],
      notes: [`memory-index: ${entries.length} memory file(s), index unchanged`],
    }
  }

  await writeAtomic(root, rel, next)
  return {
    changed: [MEMORY_INDEX],
    notes: [`memory-index: rebuilt the index from ${entries.length} memory file(s)`],
  }
}
