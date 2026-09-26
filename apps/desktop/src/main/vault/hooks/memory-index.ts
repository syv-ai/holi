/**
 * `memory-index`: `memory/index.md` lands in the same commit as the memory it
 * describes (D89). It runs at the commit boundary so the index is never a
 * follow-up commit, and a burst of memory writes yields one correct index.
 *
 * **Gated on the diff, but indexed from the tree.** The staged set decides
 * *whether* to run, so the common edit-only commit costs nothing; `listFiles`
 * decides *what* goes in, or unrelated memories would drop out.
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
 * **`deleted` matters here and nowhere else in the hook set**: this output lists
 * what EXISTS, so a deletion that did not re-index would leave the index naming
 * a file that is gone.
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

  // **Only when it differs**, or every memory edit that did not move a title
  // would restage an unchanged index.
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
