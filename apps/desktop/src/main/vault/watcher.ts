/**
 * The vault watcher: it says *when* the vault changed, and nothing else.
 *
 * No path, no kind, no payload — deliberately (plan 4 decision 6). `scanVault`
 * is a walk and a parse, cheap at this scale, and the snapshot it produces is
 * the truth. An unaddressed "something changed" is therefore everything the
 * loop needs, and being coarse is what makes the design survive a dropped
 * event: nothing downstream is holding state that only an event could repair.
 *
 * **This watcher is a hint, never a guarantee.** The macOS backend genuinely
 * drops add/unlink events — measured, the raw event never fires — so correctness
 * belongs to the caller's periodic rescan, not to event delivery. See the long
 * comment in `vitest.config.ts`.
 */
import { watch, type FSWatcher } from 'chokidar'
import { isIgnoredPath } from './vault-files'
import { toVaultRel } from './vault-files'

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
    // chokidar 4 dropped glob support in `ignored`; a function is the only
    // form now. It receives an ABSOLUTE path, and is called for directories
    // too — returning true for one prunes the whole subtree, which is what
    // keeps `.git` from being walked at all rather than merely filtered.
    ignored: (abs: string) => {
      if (abs === args.root) return false
      const rel = toVaultRel(args.root, abs)
      // Outside the root is not ours. `toVaultRel` also rejects anything
      // `vaultRelPath` refuses, so an unsafe path never reaches the callback.
      return rel === null || isIgnoredPath(rel)
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
