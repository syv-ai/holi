/**
 * Batch move: move every `from`→`to` and rewrite every inbound `[[link]]` in a
 * SINGLE pass over the full map. N independent renames would double-rewrite a
 * link whose target is itself another move's source, and race each other's
 * file writes. The renderer expands a folder to its file list before calling;
 * the router refuses clobbers.
 *
 * Read-all-then-write, deliberately. A chain (a→b, b→c) has one move's
 * destination equal to another's source, so writing as we go would overwrite a
 * file we have not yet read. There is no transaction: a mid-apply crash leaves
 * a partial move visible in `git status`, same contract as rename.
 *
 * A moved note's comment threads go with it (`moveNoteComments`), and the
 * sidecars it changed are returned for a caller that stages what it wrote.
 *
 * **A non-markdown file is carried across as bytes**, since the removal pass
 * deletes every `from` unconditionally. A utf8 round-trip would corrupt every
 * byte above 0x7f. Non-markdown files are only READ when they are moving.
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { moveNoteComments } from './note-comments'
import {
  absPathFor,
  listFiles,
  lockPath,
  removeDocFile,
  withFileLock,
  withFileLocks,
  writeAtomic,
} from './vault-files'

export async function moveNotes(
  root: string,
  moves: { from: string; to: string }[],
): Promise<{ rewritten: { path: string; count: number }[]; comments: string[] }> {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  // Every moving file and where it lands, locked for the whole move, as every
  // main-side writer takes a file: a writer that checks a file before writing
  // beside it (a meeting's, which checks its transcript before its minutes)
  // neither has a file read away under it nor writes into a folder this move
  // is emptying.
  const held = new Set<string>()
  for (const m of moves) held.add(m.from).add(m.to)
  const rewritten = await withFileLocks(
    root,
    [...held].map((p) => vaultRelPath(p)),
    () => moveLocked(root, map, held),
  )
  const comments = await moveNoteComments(root, moves)
  return { rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)), comments }
}

async function moveLocked(
  root: string,
  map: Map<string, string>,
  held: ReadonlySet<string>,
): Promise<{ path: string; count: number }[]> {
  const rewritten: { path: string; count: number }[] = []
  const planned: { dest: string; data: string | Uint8Array }[] = []

  for (const path of await listFiles(root)) {
    const dest = map.get(path)
    if (!path.endsWith('.md')) {
      // Not markdown: nothing to rewrite, and nothing to do unless it is moving.
      if (dest !== undefined) {
        planned.push({ dest, data: await readFile(absPathFor(root, vaultRelPath(path))) })
      }
      continue
    }
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8')
    const { text: next, count } = rewriteWikiLinksMulti(text, map)
    const to = dest ?? path
    if (count > 0) rewritten.push({ path: to, count })
    // A file needs writing if it moved OR its links changed; an untouched,
    // unmoved file is left exactly as it is.
    if (to !== path || count > 0) planned.push({ dest: to, data: next })
  }

  for (const from of map.keys()) await removeDocFile(root, vaultRelPath(from))
  for (const p of planned) {
    const rel = vaultRelPath(p.dest)
    // A file whose links alone changed is not held: it takes its own lock.
    if (held.has(p.dest)) await writeAtomic(root, rel, p.data)
    else await withFileLock(await lockPath(root, rel), () => writeAtomic(root, rel, p.data))
  }
  return rewritten
}
