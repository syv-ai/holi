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
import { stageNamePattern } from '../app/storage-staging'

export type NodeFilesCheckpoint = (
  phase:
    | 'stage-open'
    | 'stage-write'
    | 'stage-sync'
    | 'stage-close'
    | 'publish'
    | 'journal-before'
    | 'journal-after'
    | 'file-before'
    | 'file-after'
    | 'cleanup-before'
    | 'cleanup-after'
    | 'confirm-file'
    | 'confirm-journal'
    | 'public-sync'
    | 'private-sync'
    | 'private-directory-sync'
    | 'private-remove-sync',
) => Promise<void>

async function safe(
  root: string,
  relativePath: string,
  allowMissingLeaf = false,
  createParents = allowMissingLeaf,
): Promise<string> {
  const canonical = await realpath(root)
  const segments = relativePath.split('/')
  let current = canonical
  for (let index = 0; index < segments.length; index++) {
    const names = await readdir(current)
    const folded = (value: string) => value.normalize('NFD').toLowerCase()
    const requested = segments[index] ?? ''
    if (names.some((name) => name !== requested && folded(name) === folded(requested)))
      throw new Error('Filesystem spelling alias rejected')
    current = join(current, requested)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Symlink rejected')
      if (index < segments.length - 1 && !info.isDirectory())
        throw new Error('File ancestor collision')
      if (index === segments.length - 1 && info.isDirectory())
        throw new Error('Directory collision')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissingLeaf) throw error
      if (index < segments.length - 1 && createParents) await mkdir(current)
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
  const privateRoot = async (root: string) => {
    const canonical = await realpath(root)
    const path = join(canonical, '.holi-storage-private')
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Private storage is not a directory')
    await checkpoint?.('private-directory-sync')
    const parent = await open(canonical, 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    const directory = await open(path, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return path
  }
  const durableWrite = async (path: string, content: Uint8Array) => {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const dir = await open(dirname(path), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
  return {
    operationId: () => randomUUID().toLowerCase(),
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
    async readOptional(root, path) {
      try {
        return new Uint8Array(await readFile(await safe(root, path)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async checkMovePath(root, path) {
      await safe(root, path, true, false)
    },
    async confirm(root, path, expected) {
      await checkpoint?.('confirm-file')
      const target = await safe(root, path, true)
      const parentPath = dirname(target)
      let current: Uint8Array | null = null
      try {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid move postimage')
        current = new Uint8Array(await readFile(target))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        !Buffer.from(current ?? []).equals(Buffer.from(expected ?? [])) ||
        (current === null) !== (expected === null)
      )
        throw new Error('Unexpected move postimage')
      if (current !== null) {
        const file = await open(target, 'r')
        try {
          await file.sync()
        } finally {
          await file.close()
        }
      }
      const parent = await open(parentPath, 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    },
    async create(root, path, bytes) {
      const target = await safe(root, path, true)
      const stage = join(dirname(target), `.holi-storage-stage-${randomUUID()}.tmp`)
      let owned = false
      try {
        await writeStage(stage, bytes, checkpoint, () => (owned = true))
        await checkpoint?.('publish')
        await link(stage, target)
        const parent = await open(dirname(target), 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
        await unlink(stage)
        const parentAfterCleanup = await open(dirname(target), 'r')
        try {
          await parentAfterCleanup.sync()
        } finally {
          await parentAfterCleanup.close()
        }
        owned = false
      } finally {
        if (owned) await rm(stage, { force: true })
      }
    },
    async privateList(root) {
      const directory = await privateRoot(root)
      for (const name of await readdir(directory)) {
        if (!stageNamePattern.test(name)) continue
        const path = join(directory, name)
        const info = await lstat(path)
        if (info.isFile() && !info.isSymbolicLink()) await unlink(path)
      }
      const handle = await open(directory, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      return readdir(directory)
    },
    async privateRead(root, name) {
      if (!/^move-[0-9a-f-]+\.json$/i.test(name)) throw new Error('Invalid private artifact name')
      const target = join(await privateRoot(root), name)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid private journal file')
      return new Uint8Array(await readFile(target))
    },
    async privatePublish(root, name, content, expected) {
      if (!/^move-[0-9a-f-]+\.json$/i.test(name)) throw new Error('Invalid private artifact name')
      const directory = await privateRoot(root)
      const target = join(directory, name)
      let current: Uint8Array | null = null
      try {
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error('Invalid private journal target')
        current = new Uint8Array(await readFile(target))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        (expected === null && current !== null) ||
        (expected !== null && !Buffer.from(current ?? []).equals(Buffer.from(expected)))
      )
        throw new Error('Stale private journal')
      const temporary = join(directory, `stage-${randomUUID()}.tmp`)
      await durableWrite(temporary, content)
      await checkpoint?.('journal-before')
      await link(temporary, target)
      await unlink(temporary)
      await checkpoint?.('private-sync')
      const dir = await open(directory, 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
      await checkpoint?.('journal-after')
    },
    async privateConfirm(root, name, expected) {
      await checkpoint?.('confirm-journal')
      const target = join(await privateRoot(root), name)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid private journal file')
      const current = await readFile(target)
      if (!Buffer.from(current).equals(Buffer.from(expected)))
        throw new Error('Stale private journal confirmation')
      const file = await open(target, 'r')
      try {
        await file.sync()
      } finally {
        await file.close()
      }
      const dir = await open(dirname(target), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    },
    async privateRemove(root, name, expected) {
      const target = join(await privateRoot(root), name)
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid private journal file')
      const current = await readFile(target)
      if (!Buffer.from(current).equals(Buffer.from(expected)))
        throw new Error('Stale private journal removal')
      await unlink(target)
      await checkpoint?.('private-remove-sync')
      const dir = await open(dirname(target), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
      }
    },
    async remove(root, path, expected) {
      const target = await safe(root, path)
      const current = await readFile(target)
      if (!Buffer.from(current).equals(Buffer.from(expected))) throw new Error('Stale bytes')
      await unlink(target)
      await checkpoint?.('public-sync')
      const dir = await open(dirname(target), 'r')
      try {
        await dir.sync()
      } finally {
        await dir.close()
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
        await checkpoint?.('public-sync')
        const parent = await open(dirname(target), 'r')
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
        owned = false
      } finally {
        if (owned) await rm(stage, { force: true })
      }
    },
  }
}

export const nodeFiles = createNodeFiles()
