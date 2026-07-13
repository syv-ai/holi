/** Disk plumbing for the working copy. Every write is tmp+rename in the same
 * directory so the agent's Read never sees a torn file (spec §VaultMirror);
 * every path from disk re-validates through vaultRelPath (architecture §9). */
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isLocalOnlyPath, vaultRelPath, type VaultRelPath } from '@holi/shared'

export const TMP_MARKER = '.holi-tmp-'
const JUNK = new Set(['.DS_Store', 'Thumbs.db'])

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

/** Paths the mirror must never treat as vault content. */
export function isIgnoredPath(rel: string): boolean {
  const base = rel.split('/').at(-1)!
  return isLocalOnlyPath(rel) || base.startsWith(TMP_MARKER) || JUNK.has(base)
}

export async function writeAtomic(root: string, rel: VaultRelPath, text: string): Promise<void> {
  const abs = absPathFor(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = join(dirname(abs), `${TMP_MARKER}${randomBytes(6).toString('hex')}`)
  await writeFile(tmp, text, 'utf8')
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

/** All files under root as '/'-separated relative paths (recursive). */
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}
