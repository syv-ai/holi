/** Disk plumbing for the working copy. Every write is tmp+rename in the same
 * directory so the agent's Read never sees a torn file; every path from disk
 * re-validates through vaultRelPath. */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  GITKEEP,
  APP_LOG_FILE,
  SETTINGS_LOCAL_FILE,
  PLUGINS_LOCAL_FILE,
  THEME_LOCAL_FILE,
  IGNORED_DIRS,
  appBundleOf,
  isAppBundlePath,
  isInIgnoredDir,
  isLocalOnlyPath,
  OS_JUNK_FILES,
  vaultRelPath,
  type VaultRelPath,
} from '@holi/shared'

export const TMP_MARKER = '.holi-tmp-'
const JUNK = new Set(OS_JUNK_FILES)

export function absPathFor(root: string, rel: VaultRelPath): string {
  return join(root, rel)
}

/** abs → validated vault-relative ('/'-separated), or null when outside/unsafe. */
export function toVaultRel(root: string, absPath: string): VaultRelPath | null {
  const rel = relative(root, absPath)
  if (!rel || rel.startsWith('..') || rel === absPath) return null
  try {
    return vaultRelPath(rel.split(sep).join('/'))
  } catch {
    return null
  }
}

/**
 * Paths that are **never vault content at all** — directories we never walk
 * (`.git`, `node_modules`), tmp write-files, and OS junk. This is distinct from
 * *local-only* files (`*.local.*`): those ARE the user's content — the tree
 * shows them (under show-hidden) and the agent reads them — they just never get
 * committed (`.gitignore`). The vault store filters on THIS, so local files
 * reach the snapshot; git is what keeps them out of a commit.
 */
export function isNonContentPath(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (isInIgnoredDir(rel)) return true
  return base.startsWith(TMP_MARKER) || JUNK.has(base)
}

/**
 * Non-content **plus** local-only: the base of what the watcher ignores
 * (`isWatchIgnoredPath`). A change to `.holi/state/context.local.json`
 * (rewritten every agent turn) must not storm the rescan loop. The snapshot uses `isNonContentPath` instead, so those files
 * still appear in the tree — refreshed on the periodic heal rather than live.
 */
export function isIgnoredPath(rel: string): boolean {
  return isNonContentPath(rel) || isLocalOnlyPath(rel)
}

/**
 * What the watcher ignores: `isIgnoredPath`, minus the local files that must
 * still reload live.
 *
 *  - **The personal theme.** It stays uncommitted and out of the snapshot's
 *    notes, but editing it has to restyle the app at once.
 *  - **The personal settings.** `home:` there is a personal Home tab, which
 *    has to follow an edit the way the committed file's does.
 *  - **A personal app** (`Home.local.app`) and everything in it. The watcher
 *    prunes an ignored directory's whole subtree, so without this the agent
 *    writes the app and nothing appears until the periodic heal. A bundle
 *    inside a local folder that is not itself a bundle (`x.local/Foo.app`) is
 *    pruned with that folder and still waits for the heal.
 *
 * Seeing them is watch-only: it puts nothing into a commit.
 */
export function isWatchIgnoredPath(rel: string): boolean {
  if (isNonContentPath(rel)) return true
  if (rel === THEME_LOCAL_FILE || rel === SETTINGS_LOCAL_FILE || rel === PLUGINS_LOCAL_FILE)
    return false
  // Only a bundle that is itself local: a `.local.` file inside a shared app
  // stays unwatched like any other.
  const bundle = isAppBundlePath(rel) ? rel : appBundleOf(rel)
  // An app's log is written as it runs; watching it would rescan the vault on
  // every line, in a personal app most of all.
  if (bundle !== null && rel.slice(bundle.length + 1).toLowerCase() === APP_LOG_FILE) return true
  if (bundle !== null && isLocalOnlyPath(bundle)) return false
  return isLocalOnlyPath(rel)
}

export async function writeAtomic(
  root: string,
  rel: VaultRelPath,
  data: string | Uint8Array,
): Promise<void> {
  const abs = absPathFor(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `${TMP_MARKER}${randomBytes(6).toString('hex')}`)
  // A string still defaults to utf8; a Uint8Array/Buffer writes bytes verbatim —
  // the branded templates seed binary fonts + logo through this same writer.
  await writeFile(tmp, data)
  await rename(tmp, abs)
}

/** abs → the tail of the work queued on that file; gone once it drains. */
const fileQueues = new Map<string, Promise<void>>()

/**
 * Run `work` after every earlier `withFileLock` on the same file has settled,
 * so a check of a file and the write that depends on it are not split by
 * another caller doing the same (two app writes over one base). It orders
 * only the writers that take it: the editor's save and a pull do not, so it
 * narrows the race with them rather than closing it.
 */
export function withFileLock<T>(abs: string, work: () => Promise<T>): Promise<T> {
  const run = (fileQueues.get(abs) ?? Promise.resolve()).then(work)
  const tail = run.then(
    () => {},
    () => {},
  )
  fileQueues.set(abs, tail)
  void tail.then(() => {
    if (fileQueues.get(abs) === tail) fileQueues.delete(abs)
  })
  return run
}

export async function removeDocFile(root: string, rel: VaultRelPath): Promise<void> {
  await rm(absPathFor(root, rel), { force: true })
}

/**
 * What a folder's delete leaves once its documents are gone: `.gitkeep` files
 * (a folder's marker, never a document) and the directories that are then
 * empty, deepest first. Anything else stays, and so does every directory
 * above it: a machine-local file the delete's confirmation never listed is
 * not the delete's to take. Not a directory, or gone already: nothing.
 */
export async function pruneEmptiedFolder(root: string, rel: VaultRelPath): Promise<void> {
  const prune = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (entries === null) return false
    let empty = true
    for (const e of entries) {
      const path = join(dir, e.name)
      if (e.isDirectory()) empty = (await prune(path)) && empty
      else if (e.name === GITKEEP) await rm(path, { force: true })
      else empty = false
    }
    if (empty) await rm(dir, { recursive: true, force: true })
    return empty
  }
  await prune(absPathFor(root, rel))
}

export async function moveDocFile(
  root: string,
  from: VaultRelPath,
  to: VaultRelPath,
): Promise<void> {
  const dest = absPathFor(root, to)
  await mkdir(dirname(dest), { recursive: true })
  await rename(absPathFor(root, from), dest)
}

/**
 * All files under root as '/'-separated relative paths (recursive).
 *
 * Prunes ignored directories during the walk rather than filtering afterwards:
 * descending into `.git` on a real vault means walking the entire object store
 * to throw every result away.
 */
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (IGNORED_DIRS.has(e.name)) continue
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}
