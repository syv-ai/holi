/**
 * Writing an app's log (`APP_LOG_FILE` at its bundle's root): what its frame
 * reported going wrong, for the vault's agent to read when the app misbehaves.
 * The trimming is `appendAppLog`'s; this is the file.
 *
 * One write at a time per file, like `json-file-store.ts`: two reports at once
 * would each read the log and the second would drop the first's line. Never
 * through a symlink, and never into a bundle that is not there: a report from
 * a frame whose app was just deleted must not recreate its folder.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_LOG_FILE,
  appendAppLog,
  isAppBundlePath,
  vaultRelPath,
  type AppLogLevel,
} from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { writeAtomic } from '../../../main/plugin-api'

const queues = new Map<string, Promise<unknown>>()

export async function writeAppLog(
  root: string,
  bundle: string,
  entry: { level: AppLogLevel; text: string },
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!isAppBundlePath(bundle)) return
  const rel = vaultRelPath(`${bundle}/${APP_LOG_FILE}`)
  const run = async (): Promise<void> => {
    if ((await stat(join(root, bundle)).catch(() => null))?.isDirectory() !== true) return
    const abs = await exactPath(root, rel)
    if (abs === null) return
    const existing = await readFile(abs, 'utf8').catch(() => null)
    await writeAtomic(root, rel, appendAppLog(existing, entry, now()))
  }
  const key = join(root, rel)
  const done = (queues.get(key) ?? Promise.resolve()).then(run, run)
  const settled = done.catch(() => {})
  queues.set(key, settled)
  // The last write out forgets the queue, so it does not grow with every app.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return done
}
