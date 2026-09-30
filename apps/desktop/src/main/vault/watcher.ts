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
import { watch, type FSWatcher } from 'chokidar'
import { isWatchIgnoredPath, toVaultRel } from './vault-files'

export interface VaultWatcher {
  close(): Promise<void>
}

export async function watchVault(args: {
  root: string
  onChange: () => void
  /** Quiet period before firing. Short — the file tree has to feel live. */
  debounceMs?: number
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
      return isWatchIgnoredPath(rel)
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

  // Resolve only once the initial walk is done, so a caller that scans and then
  // starts watching cannot miss a write landing between the two.
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))

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
