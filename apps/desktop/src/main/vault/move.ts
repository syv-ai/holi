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

type Moved = { rewritten: { path: string; count: number }[]; comments: string[] }

/** The move or rename under way: they run one at a time, so one never reads
 *  a file another is moving and writes its old text, or its links, over the
 *  other's. A person's drag and the archive step are rare enough to wait.
 *  `work` must not start another move or rename, which would wait on it. */
let moving: Promise<unknown> = Promise.resolve()

export function oneMoveAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = moving.then(work)
  moving = run.catch(() => {})
  return run
}

/** Rewrite the links of a note that links to what moved: under its own
 *  lock, read again there and with no other lock held, so a save made
 *  meanwhile is kept and a note gone meanwhile is skipped. How many links
 *  changed. */
export async function relinkNote(
  root: string,
  path: string,
  rewrite: (text: string) => { text: string; count: number },
): Promise<number> {
  const rel = vaultRelPath(path)
  return withFileLock(await lockPath(root, rel), async () => {
    const text = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
    if (text === null) return 0
    const { text: next, count } = rewrite(text)
    if (count > 0) await writeAtomic(root, rel, next)
    return count
  })
}

export function moveNotes(root: string, moves: { from: string; to: string }[]): Promise<Moved> {
  return oneMoveAtATime(() => moveNow(root, moves))
}

async function moveNow(root: string, moves: { from: string; to: string }[]): Promise<Moved> {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  // Every moving file and where it lands, locked for the whole move, as every
  // main-side writer takes a file: a writer that checks a file before writing
  // beside it (a meeting's, which checks its transcript before its minutes)
  // neither has a file read away under it nor writes into a folder this move
  // is emptying.
  const held = new Set<string>()
  for (const m of moves) held.add(m.from).add(m.to)
  const { rewritten, linksOnly } = await withFileLocks(
    root,
    [...held].map((p) => vaultRelPath(p)),
    () => moveLocked(root, map),
  )
  // The files that stay and only link to what moved, once the move holds
  // nothing: no lock is taken while the move's are held (two moves of notes
  // that link each other would each wait for the other).
  for (const path of linksOnly) {
    const count = await relinkNote(root, path, (text) => rewriteWikiLinksMulti(text, map))
    if (count > 0) rewritten.push({ path, count })
  }
  const comments = await moveNoteComments(root, moves)
  return { rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)), comments }
}

/** The move itself, under every moving file's lock: the moved files written
 *  at their new paths (their own links rewritten) and removed from the old,
 *  and the files that stay but link to one of them named for afterwards. */
async function moveLocked(
  root: string,
  map: Map<string, string>,
): Promise<{ rewritten: { path: string; count: number }[]; linksOnly: string[] }> {
  const rewritten: { path: string; count: number }[] = []
  const linksOnly: string[] = []
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
    if (dest === undefined) {
      // An untouched, unmoved file is left exactly as it is.
      if (count > 0) linksOnly.push(path)
      continue
    }
    if (count > 0) rewritten.push({ path: dest, count })
    planned.push({ dest, data: next })
  }

  for (const from of map.keys()) await removeDocFile(root, vaultRelPath(from))
  for (const p of planned) await writeAtomic(root, vaultRelPath(p.dest), p.data)
  return { rewritten, linksOnly }
}
