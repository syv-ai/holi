/**
 * How the engine writes a meeting's files into the vault, and removes them: the path checked
 * (`vaultRelPath`), no symlink on the way and the case it has on disk
 * (`exactPath`), under the file's lock and written aside then renamed
 * (`writeAtomic`), as every main-side writer does. Sync takes the file from
 * there: a `.local.` one stays on this machine, any other is committed by
 * the next autosave.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { open, stat } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  pruneEmptiedFolder,
  removeDocFile,
  withFileLock,
  withFileLocks,
  writeAtomic,
} from '../../../main/plugin-api'

/**
 * Write a vault file, unless `guard`, asked under the file's lock, says no:
 * a check made outside it could pass just before a move takes the file away.
 * Whether it wrote.
 */
export async function writeVaultText(
  root: string,
  path: string,
  text: string,
  guard?: () => Promise<boolean>,
): Promise<boolean> {
  const rel = vaultRelPath(path)
  const abs = await exactPath(root, rel)
  if (abs === null) throw new Error(`refused to write ${path}: not a plain vault path`)
  return withFileLock(abs, async () => {
    if (guard !== undefined && !(await guard())) return false
    await writeAtomic(root, rel, text)
    return true
  })
}

/** Whether `path` is a folder in the vault. */
export async function vaultFolderExists(root: string, path: string): Promise<boolean> {
  const abs = await exactPath(root, vaultRelPath(path)).catch(() => null)
  if (abs === null) return false
  return stat(abs).then(
    (s) => s.isDirectory(),
    () => false,
  )
}

/**
 * Remove a meeting's own files from the vault, then its folder if nothing
 * else is left in it: a task made from the meeting, or a file a person put
 * there, keeps the folder. Sync commits the removal of a synced one. Unless
 * `guard`, asked under the files' locks, says no: the folder may have become
 * someone else's since it was checked. Whether it removed them.
 */
export async function removeVaultFiles(
  root: string,
  paths: readonly string[],
  folder: string,
  guard?: () => Promise<boolean>,
): Promise<boolean> {
  const rels = paths.map((path) => vaultRelPath(path))
  for (const rel of rels) {
    if ((await exactPath(root, rel)) === null) {
      throw new Error(`refused to remove ${rel}: not a plain vault path`)
    }
  }
  // All of them at once, as every delete of several files holds them.
  const removed = await withFileLocks(root, rels, async () => {
    if (guard !== undefined && !(await guard())) return false
    for (const rel of rels) await removeDocFile(root, rel)
    return true
  })
  if (removed) await pruneEmptiedFolder(root, vaultRelPath(folder))
  return removed
}

/** How much of a transcript is read to know it: its id, or the placeholder,
 *  even one from before placeholders had frontmatter, whose marker line comes
 *  after a title of up to 120 characters of any script.
 *
 *  @public exported for the test rig's own reader */
export const HEAD_BYTES = 1024

/** The first `bytes` of a vault file as text, or null when there is none:
 *  enough to read the id a meeting's transcript starts with. */
export async function readVaultHead(
  root: string,
  path: string,
  bytes = HEAD_BYTES,
): Promise<string | null> {
  const abs = await exactPath(root, vaultRelPath(path)).catch(() => null)
  if (abs === null) return null
  const file = await open(abs, 'r').catch(() => null)
  if (file === null) return null
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await file.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}
