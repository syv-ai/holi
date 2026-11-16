import { randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isInIgnoredDir, isLocalOnlyPath, isSecretPath } from '@holi/shared/mobile-path-safety'
import type { Entry, NativeFiles } from '../app/native-files'

export type NodeFilesCheckpoint = (
  phase: 'stage-open' | 'stage-write' | 'stage-sync' | 'stage-close' | 'publish',
) => Promise<void>

async function safe(root: string, relativePath: string, allowMissingLeaf = false): Promise<string> {
  const canonical = await realpath(root)
  const segments = relativePath.split('/')
  let current = canonical
  for (let index = 0; index < segments.length; index++) {
    const names = await readdir(current)
    const folded = (value: string) => value.normalize('NFD').toLowerCase()
    const found = names.find((name) => folded(name) === folded(segments[index]))
    if (found && found.normalize('NFC') !== segments[index].normalize('NFC'))
      throw new Error('Case alias rejected')
    current = join(current, found ?? segments[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Symlink rejected')
      if (index < segments.length - 1 && !info.isDirectory())
        throw new Error('File ancestor collision')
      if (index === segments.length - 1 && info.isDirectory())
        throw new Error('Directory collision')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissingLeaf) throw error
      if (index < segments.length - 1) await mkdir(current)
    }
  }
  const resolved = relative(canonical, current)
  if (resolved.startsWith(`..${sep}`) || resolved === '..') throw new Error('Outside vault')
  return current
}

async function writeStage(
  path: string,
  bytes: Uint8Array,
  checkpoint: NodeFilesCheckpoint | undefined,
  acquired: () => void,
) {
  const handle = await open(path, 'wx')
  acquired()
  let failure: unknown
  try {
    await checkpoint?.('stage-open')
    await handle.writeFile(bytes)
    await checkpoint?.('stage-write')
    await handle.sync()
    await checkpoint?.('stage-sync')
  } catch (error) {
    failure = error
  }
  try {
    await handle.close()
    await checkpoint?.('stage-close')
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
}

export function createNodeFiles(checkpoint?: NodeFilesCheckpoint): NativeFiles {
  return {
    async canonicalRoot(root) {
      return realpath(root)
    },
    async list(root) {
      const result: Entry[] = []
      const walk = async (dir: string) => {
        for (const name of await readdir(dir)) {
          const absolute = join(dir, name)
          const rel = relative(root, absolute).split(sep).join('/')
          if (isInIgnoredDir(rel) || isLocalOnlyPath(rel) || isSecretPath(rel)) continue
          if (rel.split('/').some((part) => part.startsWith('.holi-storage-'))) continue
          const info = await lstat(absolute)
          if (info.isSymbolicLink()) continue
          result.push({ path: rel, kind: info.isDirectory() ? 'directory' : 'file' })
          if (info.isDirectory()) await walk(absolute)
        }
      }
      await walk(root)
      return result
    },
    async read(root, path) {
      return new Uint8Array(await readFile(await safe(root, path)))
    },
    async create(root, path, bytes) {
      const target = await safe(root, path, true)
      const stage = join(dirname(target), `.holi-storage-stage-${randomUUID()}.tmp`)
      let owned = false
      try {
        await writeStage(stage, bytes, checkpoint, () => (owned = true))
        await link(stage, target)
        await unlink(stage)
        owned = false
      } finally {
        if (owned) await rm(stage, { force: true })
      }
    },
    async publish(root, path, bytes, expected) {
      const target = await safe(root, path)
      const before = await readFile(target)
      if (expected && !Buffer.from(before).equals(Buffer.from(expected)))
        throw new Error('Stale bytes')
      const stage = join(dirname(target), `.holi-storage-stage-${randomUUID()}.tmp`)
      let owned = false
      try {
        await writeStage(stage, bytes, checkpoint, () => (owned = true))
        const current = await readFile(target)
        if (!Buffer.from(current).equals(Buffer.from(before)))
          throw new Error('Changed during save')
        await checkpoint?.('publish')
        await rename(stage, target)
        owned = false
      } finally {
        if (owned) await rm(stage, { force: true })
      }
    },
  }
}

export const nodeFiles = createNodeFiles()
