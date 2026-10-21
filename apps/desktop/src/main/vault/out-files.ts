/**
 * `.holi/state/out/`: where a `holi` answer too long to print is written for the
 * agent to read instead (`bridge/spill.ts`).
 *
 * The files are machine state, local by their `.local.` marker so they are
 * never committed, and out of a vault app's reach like the rest of
 * `.holi/state/`. Each is read in the turn that asked for it, so only the
 * newest `KEEP` are kept. (A screenshot goes to the OS temp directory instead,
 * `main/screenshot-files.ts`: it has nothing to do in the vault at all.)
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MACHINE_STATE_DIR, vaultRelPath } from '@holi/shared'
import { writeAtomic } from './vault-files'

export const OUT_DIR = `${MACHINE_STATE_DIR}/out`

/** How many are kept per vault: enough to outlast a busy stretch of a few
 *  sessions side by side. */
const KEEP = 50

/**
 * Write `data` as a new file under the vault at `root`, named
 * `spill-<stamp>[-<tag>]-<rand>.local.<ext>`, then prune. Returns its
 * vault-relative path.
 */
export async function writeOut(
  root: string,
  data: string,
  { ext, tag }: { ext: string; tag?: string },
): Promise<string> {
  // An ISO stamp first, so the names sort oldest first; the random tail keeps
  // two in the same millisecond apart.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parts = [
    'spill',
    stamp,
    ...(tag === undefined ? [] : [tag]),
    randomBytes(3).toString('hex'),
  ]
  const rel = `${OUT_DIR}/${parts.join('-')}.local.${ext}`
  await writeAtomic(root, vaultRelPath(rel), data)
  await prune(join(root, OUT_DIR))
  return rel
}

/** Remove all but the newest `KEEP`. A failure is ignored: the next write
 *  tries again, and an extra file costs nothing meanwhile. */
async function prune(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir))
      .filter((n) => n.startsWith('spill-') && n.includes('.local.'))
      .sort()
    await Promise.all(names.slice(0, -KEEP).map((n) => rm(join(dir, n), { force: true })))
  } catch {
    // See the doc comment.
  }
}
