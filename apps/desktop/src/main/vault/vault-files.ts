/** Disk plumbing for the working copy. Every write is tmp+rename in the same
 * directory so the agent's Read never sees a torn file (spec §VaultMirror);
 * every path from disk re-validates through vaultRelPath (architecture §9). */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isLocalOnlyPath, vaultRelPath, type VaultRelPath } from '@holi/shared'

export const TMP_MARKER = '.holi-tmp-'
const JUNK = new Set(['.DS_Store', 'Thumbs.db'])

/** Directories that are never vault content, matched on any path segment.
 *
 * `.git` is the load-bearing one and it is new with D60: the vault is a clone
 * now, so the repo's own database sits inside the tree the watcher walks. Left
 * unignored it would be thousands of files, it would fire the watcher on every
 * commit Holi itself makes (an autosave loop), and a stray `.md` under
 * `.git/` would surface as a note. */
const IGNORED_DIRS = new Set(['.git', 'node_modules'])

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
  const segments = rel.split('/')
  const base = segments.at(-1)!
  if (segments.some((s) => IGNORED_DIRS.has(s))) return true
  return base.startsWith(TMP_MARKER) || JUNK.has(base)
}

/**
 * Non-content **plus** local-only. This is what the *watcher* ignores: a change
 * to `.holi/context.local.json` (rewritten every agent turn) must not storm the
 * rescan loop. The snapshot uses `isNonContentPath` instead, so those files
 * still appear in the tree — refreshed on the periodic heal rather than live.
 */
export function isIgnoredPath(rel: string): boolean {
  return isNonContentPath(rel) || isLocalOnlyPath(rel)
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

export async function removeDocFile(root: string, rel: VaultRelPath): Promise<void> {
  await rm(absPathFor(root, rel), { force: true })
}

export async function moveDocFile(root: string, from: VaultRelPath, to: VaultRelPath): Promise<void> {
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
