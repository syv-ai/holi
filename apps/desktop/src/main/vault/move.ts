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
 *
 * **A non-markdown file is carried across as bytes.** Only `.md` is read for the
 * link rewrite, and for a long time that was also the only thing written back —
 * while the removal pass below deleted every `from` unconditionally. Moving an
 * image or a stylesheet therefore DELETED it and put nothing at the
 * destination. Nothing in the product could reach that (every caller expands its
 * target through `filesUnder(docPaths, …)`, which is markdown only), but it was
 * a loaded gun aimed at the first caller that could — which is why an app rename
 * moves its directory instead of coming through here.
 *
 * Bytes, not text: a `Buffer` round-trip through utf8 would corrupt every byte
 * above 0x7f, so a PNG would arrive at its destination ruined rather than
 * missing. Non-markdown files are also only READ when they are actually moving —
 * the rewrite pass has no use for them, and a vault's binaries should not be
 * loaded into memory to move one note.
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
  for (const p of planned) await writeAtomic(root, vaultRelPath(p.dest), p.data)

  return { rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)) }
}
