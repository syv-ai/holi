/**
 * Where `holi docs screenshot` puts its PNGs: the OS temp directory, in a
 * folder only this user can enter, never the vault. A screenshot is read once,
 * in the turn that asked for it, so it has no business in the clone; outside
 * the vault it cannot be committed, synced or reached by a vault app, and it
 * carries what was on screen, so it is owner-only. The command prints the
 * absolute path for the agent to read.
 *
 * Each write prunes: the newest `KEEP` are kept, and none older than `MAX_AGE_MS`.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** @public exported for its test */
export const SCREENSHOT_DIR = join(tmpdir(), 'holi-screenshots')

const KEEP = 20
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The folder, created owner-only, and refused when it is not plainly ours: a
 * symlink, or (where the OS has user ids) a folder another user made first in a
 * shared temp directory, would hand them what the person's screen showed.
 */
async function ownDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`${dir} is not a folder of this user's`)
  }
  await chmod(dir, 0o700)
}

/** Write `png` as a new file under `dir`, prune, and return its absolute path. */
export async function writeScreenshot(
  png: Uint8Array,
  { dir = SCREENSHOT_DIR, now = Date.now() }: { dir?: string; now?: number } = {},
): Promise<string> {
  await ownDir(dir)
  // A stamp first, so the names sort oldest first; the random tail keeps two
  // in the same millisecond apart and makes the name unguessable.
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${stamp}-${randomBytes(6).toString('hex')}.png`)
  await writeFile(path, png, { mode: 0o600, flag: 'wx' })
  await prune(dir, path, now)
  return path
}

/** Remove all but the newest `KEEP`, and any older than a day, never the one
 *  just written. A failure is ignored: the next write tries again. */
async function prune(dir: string, keep: string, now: number): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort()
    const old = new Set(names.slice(0, -KEEP))
    for (const name of names) {
      const path = join(dir, name)
      if (path === keep) continue
      if (!old.has(name)) {
        const { mtimeMs } = await stat(path)
        if (now - mtimeMs < MAX_AGE_MS) continue
      }
      await rm(path, { force: true })
    }
  } catch {
    // See the doc comment.
  }
}
