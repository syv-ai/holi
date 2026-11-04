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
import { open } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  pruneEmptiedFolder,
  removeDocFile,
  withFileLock,
  writeAtomic,
} from '../../../main/plugin-api'

export async function writeVaultText(root: string, path: string, text: string): Promise<void> {
  const rel = vaultRelPath(path)
  const abs = await exactPath(root, rel)
  if (abs === null) throw new Error(`refused to write ${path}: not a plain vault path`)
  await withFileLock(abs, () => writeAtomic(root, rel, text))
}

/**
 * Remove a meeting's own files from the vault, then its folder if nothing
 * else is left in it: a task made from the meeting, or a file a person put
 * there, keeps the folder. Sync commits the removal of a synced one.
 */
export async function removeVaultFiles(
  root: string,
  paths: readonly string[],
  folder: string,
): Promise<void> {
  for (const path of paths) {
    const rel = vaultRelPath(path)
    const abs = await exactPath(root, rel)
    if (abs === null) throw new Error(`refused to remove ${path}: not a plain vault path`)
    await withFileLock(abs, () => removeDocFile(root, rel))
  }
  await pruneEmptiedFolder(root, vaultRelPath(folder))
}

/** The first `bytes` of a vault file as text, or null when there is none:
 *  enough to read the id a meeting's transcript starts with. */
export async function readVaultHead(
  root: string,
  path: string,
  bytes = 256,
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
