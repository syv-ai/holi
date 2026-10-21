/**
 * Where `holi docs screenshot` puts its PNG: a file in `.holi/state/out/`,
 * the directory a `holi` command writes what it hands the agent to read.
 * Machine state, local by its `.local.` marker so it is never committed, and
 * out of a vault app's reach like the rest of `.holi/state/`. Only the newest
 * `KEEP` screenshots are kept: each is read in the turn that took it.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomBytes } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MACHINE_STATE_DIR, vaultRelPath } from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

export const OUT_DIR = `${MACHINE_STATE_DIR}/out`

const KEEP = 20
const SUFFIX = '-screenshot.local.png'

/** Write `png` as a new screenshot under the vault at `root`; its vault path. */
export async function writeScreenshot(root: string, png: Uint8Array): Promise<string> {
  // An ISO stamp first, so names sort oldest first; the random part keeps two
  // in the same millisecond apart.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rel = `${OUT_DIR}/${stamp}-${randomBytes(3).toString('hex')}${SUFFIX}`
  await writeAtomic(root, vaultRelPath(rel), png)
  await prune(join(root, OUT_DIR))
  return rel
}

/** All but the newest `KEEP` screenshots go. A failure is ignored: the next
 *  one tries again. */
async function prune(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(SUFFIX)).sort()
    await Promise.all(names.slice(0, -KEEP).map((n) => rm(join(dir, n), { force: true })))
  } catch {
    // See the doc comment.
  }
}
