/**
 * The vault watcher: it says *when* the vault changed, and nothing else.
 *
 * No path, no kind, no payload, deliberately. `scanVault` is cheap and its
 * snapshot is the truth, so being coarse is what survives a dropped event:
 * nothing downstream holds state that only an event could repair.
 *
 * **This watcher is a hint, never a guarantee.** The macOS backend genuinely
 * drops add/unlink events, so correctness belongs to the caller's periodic
 * rescan. See the comment in `vitest.config.ts`.
 */
import { rm, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { isNonContentPath, isWatchIgnoredPath, tmpPathIn, toVaultRel } from './vault-files'

export interface VaultWatcher {
  close(): Promise<void>
}

/** How long to wait for the probe before giving up on it: a vault Holi cannot
 *  write to is still watched, it just loses the first moments to the heal tick. */
const LISTEN_BUDGET_MS = 2_000

/**
 * Wait until the OS is delivering events for the vault.
 *
 * On macOS chokidar's `ready` comes before anyone is listening: Node starts a
 * directory's FSEvents stream on another thread after `fs.watch` returns, and a
 * write made before that stream starts is never delivered at all. Measured, a
 * write 0-3 ms after `ready` was lost 4 times in 60 for a new folder and 1 in 60
 * for a file, and the vault did not see it until the next heal tick. So write a
 * tmp file, which every reader skips, and wait to hear it.
 */
async function listening(watcher: FSWatcher, root: string): Promise<void> {
  const probe = tmpPathIn(root)
  const name = basename(probe)
  let onRaw: (event: string, path: string) => void = () => {}
  const heard = new Promise<void>((resolve) => {
    onRaw = (_event, path) => {
      if (path === name || path === probe) resolve()
    }
    watcher.on('raw', onRaw)
  })
  let timer: NodeJS.Timeout | undefined
  try {
    await writeFile(probe, '')
    await Promise.race([heard, new Promise((r) => (timer = setTimeout(r, LISTEN_BUDGET_MS)))])
  } catch {
    // A read-only vault: watch it anyway.
  } finally {
    clearTimeout(timer)
    watcher.off('raw', onRaw)
    await rm(probe, { force: true }).catch(() => {})
  }
}

export async function watchVault(args: {
  root: string
  onChange: () => void
  /** Quiet period before firing. Short — the file tree has to feel live. */
  debounceMs?: number
  /** A file to watch although `isWatchIgnoredPath` would skip it: a local
   *  file a plugin claims (a private task), which has to reload live like
   *  any task. Asked of files only, never of a non-content path. */
  watches?: (rel: string) => boolean
}): Promise<VaultWatcher> {
  const debounceMs = args.debounceMs ?? 200
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const watcher: FSWatcher = watch(args.root, {
    // Without this, opening a vault fires once per file already in it.
    ignoreInitial: true,
    // chokidar 4 takes only a function in `ignored`. It receives an ABSOLUTE path, and is called for directories
    // too — returning true for one prunes the whole subtree, which is what
    // keeps `.git` from being walked at all rather than merely filtered.
    ignored: (abs: string) => {
      if (abs === args.root) return false
      const rel = toVaultRel(args.root, abs)
      // Outside the root, or a path `vaultRelPath` refuses — never ours.
      if (rel === null) return true
      // `toVaultRel` also rejects anything `vaultRelPath` refuses, so an unsafe
      // path never reaches the callback.
      if (!isWatchIgnoredPath(rel)) return false
      return isNonContentPath(rel) || args.watches?.(rel) !== true
    },
  })

  const fire = () => {
    if (closed) return
    timer = null
    args.onChange()
  }

  const schedule = () => {
    if (closed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(fire, debounceMs)
  }

  watcher.on('add', schedule)
  watcher.on('change', schedule)
  watcher.on('unlink', schedule)
  watcher.on('addDir', schedule)
  watcher.on('unlinkDir', schedule)
  // An error must not take the process down. The heal tick is the backstop for
  // whatever this watcher stops seeing.
  watcher.on('error', (err) => console.error('[watcher]', err))

  // Resolve only once the watcher hears: chokidar's walk is done at `ready`, and
  // the OS is listening once the probe below comes back.
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
  await listening(watcher, args.root)

  return {
    async close() {
      closed = true
      // A pending debounce would otherwise fire into a vault that has already
      // released its repo, and surface as a failure somewhere unrelated.
      if (timer !== null) clearTimeout(timer)
      timer = null
      await watcher.close()
    },
  }
}
