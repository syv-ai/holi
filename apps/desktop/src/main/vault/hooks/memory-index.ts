/**
 * `memory-index`: `.holi/memory/index.md` lands in the same commit as the memory it
 * describes. It runs at the commit boundary so the index is never a
 * follow-up commit, and a burst of memory writes yields one correct index.
 *
 * **Gated on the diff, then indexed from the tree only when it matches the
 * staged memory tree.** The staged set decides *whether* to run, so the common
 * edit-only commit costs nothing; `listFiles` decides *what* goes in, or
 * unrelated memories would drop out. If an unstaged or untracked shared memory
 * differs from what this commit can contain, defer rather than leak its metadata.
 *
 * A memory past its `expires` is left out (docs/features/agent-memory.md). The
 * file itself stays: shared memory is never deleted unattended, so the memory
 * lint reports it for the agent to propose deleting.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  MEMORY_INDEX,
  isExpiredMemory,
  isSharedMemoryPath,
  readMemoryEntry,
  renderMemoryIndex,
  vaultRelPath,
  type MemoryEntry,
} from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

const exec = promisify(execFile)

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

/**
 * Whether any shared memory in the working tree is not represented by the
 * staged tree. Autosave holds oversized files back, but a transform that scans
 * the working tree must not let their metadata leak into this commit's index.
 */
async function hasUnstagedSharedMemory(root: string): Promise<boolean> {
  const [unstaged, untracked] = await Promise.all([
    exec('git', ['diff', '--name-only', '-z', '--', '.holi/memory'], { cwd: root }),
    exec('git', ['ls-files', '--others', '-z', '--', '.holi/memory'], { cwd: root }),
  ])
  return [...unstaged.stdout.split('\0'), ...untracked.stdout.split('\0')].some(
    (path) => path !== '' && isSharedMemoryPath(path),
  )
}

export async function memoryIndex(
  root: string,
  staged: StagedChanges,
  now = new Date(),
): Promise<TransformResult> {
  if (!touchesSharedMemory(staged)) return { changed: [], notes: [] }
  if (await hasUnstagedSharedMemory(root)) {
    return {
      changed: [],
      notes: ['memory-index: deferred because shared memory differs from the staged tree'],
    }
  }
  const { changed, count } = await writeMemoryIndex(root, now)
  if (!changed) {
    return { changed: [], notes: [`memory-index: ${count} memory file(s), index unchanged`] }
  }
  return {
    changed: [MEMORY_INDEX],
    notes: [`memory-index: rebuilt the index from ${count} memory file(s)`],
  }
}

/**
 * Write the index the tree's shared memories make, ungated. The transform calls
 * it when a commit touches memory, and a merge calls it when the two sides'
 * indexes conflict: the index is generated, so the merged tree's memories are
 * the one right answer to that conflict.
 */
export async function writeMemoryIndex(
  root: string,
  now = new Date(),
): Promise<{ changed: boolean; count: number }> {
  const entries: MemoryEntry[] = []
  for (const path of await listFiles(root)) {
    if (!isSharedMemoryPath(path)) continue
    // A memory deleted between `listFiles` and this read is ordinary, not an
    // error: the commit being made may be the one deleting it.
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8').catch(() => null)
    if (text === null || isExpiredMemory(path, text, now)) continue
    entries.push(readMemoryEntry(path, text))
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const next = renderMemoryIndex(entries)
  const rel = vaultRelPath(MEMORY_INDEX)
  const current = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)

  // **Only when it differs**, or every memory edit that did not move a title
  // would restage an unchanged index.
  if (current === next) return { changed: false, count: entries.length }
  await writeAtomic(root, rel, next)
  return { changed: true, count: entries.length }
}
