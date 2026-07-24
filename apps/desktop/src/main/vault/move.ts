/**
 * Batch move: move every `from`→`to` and rewrite every inbound `[[link]]` in a
 * SINGLE pass over the full map (spec §The move link-rewrite). This is
 * `renameNote` generalized from one pair to a map, and the generalization is the
 * whole point: N independent renames double-rewrite a link whose target is
 * itself another move's source, and race each other's file writes. The renderer
 * expands a folder to its file list before calling; the router refuses clobbers.
 *
 * Read-all-then-write, deliberately. A chain (a→b, b→c) has one move's
 * destination equal to another's source, so writing as we go would overwrite a
 * file we have not yet read. Every file's new content is computed from the
 * on-disk originals first; only then are sources removed and destinations
 * written. There is no transaction — a mid-apply crash leaves a partial move
 * visible in `git status`, same contract as rename (prd §Rename).
 */
import { readFile } from 'node:fs/promises'
import { rewriteWikiLinksMulti, vaultRelPath } from '@holi/shared'
import { absPathFor, listFiles, removeDocFile, writeAtomic } from './vault-files'

export async function moveNotes(
  root: string,
  moves: { from: string; to: string }[],
): Promise<{ rewritten: { path: string; count: number }[] }> {
  const map = new Map(moves.map((m) => [m.from, m.to]))
  const rewritten: { path: string; count: number }[] = []
  const planned: { dest: string; text: string }[] = []

  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md')) continue
    const text = await readFile(absPathFor(root, vaultRelPath(path)), 'utf8')
    const { text: next, count } = rewriteWikiLinksMulti(text, map)
    const dest = map.get(path) ?? path
    if (count > 0) rewritten.push({ path: dest, count })
    // A file needs writing if it moved OR its links changed; an untouched,
    // unmoved file is left exactly as it is.
    if (dest !== path || count > 0) planned.push({ dest, text: next })
  }

  for (const from of map.keys()) await removeDocFile(root, vaultRelPath(from))
  for (const p of planned) await writeAtomic(root, vaultRelPath(p.dest), p.text)

  return { rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)) }
}
