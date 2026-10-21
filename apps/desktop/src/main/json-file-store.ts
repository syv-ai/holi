/**
 * A small JSON file in `userData` that main reads and rewrites: the vault
 * registry, Google's per-vault accounts and calendar and image choices, app
 * approvals.
 *
 * Two things every one of them needs and each used to get half of:
 *
 * - **Written aside and renamed.** A crash mid-write must not leave a
 *   truncated file, which a read would discard along with every entry in it.
 * - **One change at a time.** An update reads the file, changes it and writes
 *   it back; two at once would each read the same file, and the second rename
 *   would drop the first's change. Updates queue, and each sees the file as
 *   the one before it left it.
 *
 * `parse` validates what is on disk and is handed `null` for a file that is
 * missing or not JSON, so each store decides what its empty state is and what
 * a hand edit gone wrong costs.
 *
 * Read from disk every time unless `cache` is set: these are files a developer
 * may open and fix, and a read that ignores the fix is a confusing bug. Main is
 * the only writer, so a cache is safe where reads are hot (the registry is
 * read by every path-taking procedure).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface JsonFileStore<T> {
  read(): Promise<T>
  /** Replace the contents with `change(current)`, queued behind every earlier
   *  update. Resolves to what was written; a `change` that throws writes nothing.
   *  `change` returns a new value rather than editing `current`, which may be
   *  the cached one. */
  update(change: (current: T) => T | Promise<T>): Promise<T>
}

export function jsonFileStore<T>(
  path: string,
  parse: (raw: unknown) => T,
  options: { cache?: boolean } = {},
): JsonFileStore<T> {
  let cached: { value: T } | null = null
  let queue: Promise<unknown> = Promise.resolve()
  /** Bumped by every write, so a read that began before one cannot cache
   *  what the write replaced. */
  let writes = 0

  const read = async (): Promise<T> => {
    if (cached !== null) return cached.value
    const began = writes
    const text = await readFile(path, 'utf8').catch(() => null)
    let raw: unknown = null
    if (text !== null) {
      try {
        raw = JSON.parse(text)
      } catch {
        raw = null
      }
    }
    const value = parse(raw)
    if (options.cache === true && cached === null && writes === began) cached = { value }
    return value
  }

  const write = async (value: T): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
    writes += 1
    if (options.cache === true) cached = { value }
  }

  return {
    read,
    update(change) {
      const run = async (): Promise<T> => {
        const next = await change(await read())
        await write(next)
        return next
      }
      const done = queue.then(run, run)
      queue = done.catch(() => {})
      return done
    },
  }
}
