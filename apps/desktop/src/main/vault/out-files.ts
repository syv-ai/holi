/**
 * `.holi/state/out/`: where a `holi` command writes what it hands the agent to
 * read instead of printing it, a long answer (`bridge/spill.ts`) or a tab's PNG
 * (`holi docs screenshot`).
 *
 * The files are machine state, local by their `.local.` marker so they are
 * never committed, and out of a vault app's reach like the rest of
 * `.holi/state/`. Each is read in the turn that asked for it, so only the
 * newest few of each kind are kept. A name starts with its kind, so one kind's
 * pruning never touches another's: a burst of long answers cannot remove the
 * screenshot the agent is about to look at.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MACHINE_STATE_DIR, vaultRelPath } from '@holi/shared'
import { writeAtomic } from './vault-files'

export const OUT_DIR = `${MACHINE_STATE_DIR}/out`

/** What is written, and how many of it are kept per vault. A spill only has
 *  to outlast a busy stretch of a few sessions side by side; a screenshot is
 *  larger and read at once. */
const KEEP = { spill: 50, screenshot: 20 } as const

export type OutKind = keyof typeof KEEP

/**
 * Write `data` as a new `kind` file under the vault at `root`, named
 * `<kind>-<stamp>[-<tag>]-<rand>.local.<ext>`, then prune that kind. Returns
 * its vault-relative path.
 */
export async function writeOut(
  root: string,
  kind: OutKind,
  data: string | Uint8Array,
  { ext, tag }: { ext: string; tag?: string },
): Promise<string> {
  // An ISO stamp after the kind, so a kind's names sort oldest first; the
  // random tail keeps two in the same millisecond apart.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parts = [kind, stamp, ...(tag === undefined ? [] : [tag]), randomBytes(3).toString('hex')]
  const rel = `${OUT_DIR}/${parts.join('-')}.local.${ext}`
  await writeAtomic(root, vaultRelPath(rel), data)
  await prune(join(root, OUT_DIR), kind)
  return rel
}

/** Remove all but the newest `KEEP[kind]` files of `kind`. A failure is
 *  ignored: the next write tries again, and an extra file costs nothing
 *  meanwhile. */
async function prune(dir: string, kind: OutKind): Promise<void> {
  try {
    const names = (await readdir(dir))
      .filter((n) => n.startsWith(`${kind}-`) && n.includes('.local.'))
      .sort()
    await Promise.all(names.slice(0, -KEEP[kind]).map((n) => rm(join(dir, n), { force: true })))
  } catch {
    // See the doc comment.
  }
}
