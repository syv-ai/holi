/**
 * Writing an app's log (`APP_LOG_FILE` at its bundle's root): what its frame
 * reported going wrong, for the vault's agent to read when the app misbehaves.
 * The trimming is `appendAppLog`'s; this is the file.
 *
 * Reports gather for `BATCH_MS` and are written together: a chatty app's
 * console costs one rewrite of the file a second, not one per line. One write
 * at a time per file, like `json-file-store.ts`: two at once would each read
 * the log and the second would drop the first's lines. Never through a
 * symlink, and never into a bundle that is not there: a report from a frame
 * whose app was just deleted must not recreate its folder.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_LOG_FILE, isAppBundlePath, vaultRelPath } from '@holi/shared'
import { appendAppLog, type AppLogEntry, type AppLogLevel } from '../shared/store'
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError, writeAtomic } from '../../../main/plugin-api'

const BATCH_MS = 1000

const queues = new Map<string, Promise<unknown>>()

/** The reports gathering for one file, and how to write them now. */
const batches = new Map<
  string,
  { entries: AppLogEntry[]; flush: () => void; written: Promise<void> }
>()

/** Add a report to the app's log; resolves once it is written. */
export function writeAppLog(
  root: string,
  bundle: string,
  entry: { level: AppLogLevel; text: string },
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!isAppBundlePath(bundle)) return Promise.resolve()
  const rel = vaultRelPath(`${bundle}/${APP_LOG_FILE}`)
  const key = join(root, rel)
  let batch = batches.get(key)
  if (batch === undefined) {
    const entries: AppLogEntry[] = []
    let release = (): void => {}
    const due = new Promise<void>((resolve) => (release = resolve))
    const timer = setTimeout(() => flush(), BATCH_MS)
    const flush = (): void => {
      clearTimeout(timer)
      if (batches.get(key)?.entries === entries) batches.delete(key)
      release()
    }
    const run = async (): Promise<void> => {
      if ((await stat(join(root, bundle)).catch(() => null))?.isDirectory() !== true) return
      const abs = await exactPath(root, rel)
      if (abs === null) return
      const existing = await readFile(abs, 'utf8').catch(() => null)
      await writeAtomic(root, rel, appendAppLog(existing, entries, now()))
    }
    batch = { entries, flush, written: due.then(() => queued(key, run)) }
    batches.set(key, batch)
  }
  batch.entries.push({ ...entry, at: now() })
  return batch.written
}

/**
 * Write what is gathering for the app's log now; resolves once written.
 * @public exported for its test
 */
export function flushAppLog(root: string, bundle: string): Promise<void> {
  const batch = batches.get(join(root, `${bundle}/${APP_LOG_FILE}`))
  if (batch === undefined) return Promise.resolve()
  batch.flush()
  return batch.written
}

/** `run` after every write already queued for `key`. */
function queued(key: string, run: () => Promise<void>): Promise<void> {
  const done = (queues.get(key) ?? Promise.resolve()).then(run, run)
  const settled = done.catch(() => {})
  queues.set(key, settled)
  // The last write out forgets the queue, so it does not grow with every app.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return done
}

/** The app's log as it is on disk, or null when nothing has been logged yet.
 *  Never through a symlink; an app that is not there is a NOT_FOUND. */
export async function readAppLog(root: string, bundle: string): Promise<string | null> {
  // What the app reported in the last moment is in it too.
  await flushAppLog(root, bundle).catch(() => {})
  const dir = await exactPath(root, vaultRelPath(bundle))
  if (dir === null || (await stat(dir).catch(() => null))?.isDirectory() !== true) {
    throw new CapabilityError('NOT_FOUND', bundle)
  }
  const abs = await exactPath(root, vaultRelPath(`${bundle}/${APP_LOG_FILE}`))
  return abs === null ? null : await readFile(abs, 'utf8').catch(() => null)
}
