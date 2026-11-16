import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { isInIgnoredDir, isLocalOnlyPath, isSecretPath } from '@holi/shared/mobile-path-safety'
import type { Entry, NativeFiles } from '../app/native-files'

async function safe(root: string, relativePath: string, allowMissingLeaf = false): Promise<string> {
  const canonical = await realpath(root)
  const segments = relativePath.split('/')
  let current = canonical
  for (let index = 0; index < segments.length; index++) {
    const names = await readdir(current)
    const folded = (value: string) => value.normalize('NFD').toLowerCase()
    const found = names.find((name) => folded(name) === folded(segments[index]))
    if (found && found !== segments[index]) throw new Error('Case alias rejected')
    current = join(current, segments[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('Symlink rejected')
      if (index < segments.length - 1 && !info.isDirectory())
        throw new Error('File ancestor collision')
      if (index === segments.length - 1 && info.isDirectory())
        throw new Error('Directory collision')
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissingLeaf) throw error
      if (index < segments.length - 1) await mkdir(current)
    }
  }
  const resolved = relative(canonical, current)
  if (resolved.startsWith(`..${sep}`) || resolved === '..') throw new Error('Outside vault')
  return current
}

export const nodeFiles: NativeFiles = {
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
    const handle = await (await import('node:fs/promises')).open(target, 'wx')
    let owned = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } catch (error) {
      if (owned) await rm(target, { force: true })
      throw error
    } finally {
      await handle.close()
      owned = false
    }
  },
  async publish(root, path, bytes, expected) {
    const target = await safe(root, path)
    const before = await readFile(target)
    if (expected && !Buffer.from(before).equals(Buffer.from(expected)))
      throw new Error('Stale bytes')
    const temporary = join(dirname(target), `.holi-storage-stage-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      const current = await readFile(target)
      if (!Buffer.from(current).equals(Buffer.from(before))) throw new Error('Changed during save')
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  },
}
