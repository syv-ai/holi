import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { basename, dirname, join, relative, sep } from 'node:path'
import { CapabilityError } from '../../../main/plugin-api'

const execFile = promisify(execFileCallback)
const MAX_ENTRIES = 2048
const MAX_DEPTH = 32
const MAX_BYTES = 32 * 1024 * 1024
const fail = (message: string): never => {
  throw new CapabilityError('BAD_REQUEST', message)
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== path)
}
const check = async (options: AppPublicationOptions) => {
  if (options.signal?.aborted) throw new CapabilityError('FORBIDDEN', 'publication cancelled')
  await options.guard?.()
}
const inode = (info: Awaited<ReturnType<typeof lstat>>) =>
  `${info.dev}:${info.ino}:${Number(info.mode) & 0o170000}`
type AppPublicationOptions = {
  guard?: () => void | Promise<void>
  signal?: AbortSignal
  release?: { root: string; commit: string; sourcePath: string }
}
type Item = { path: string; bytes: Buffer; mode: number }

async function authenticatedFiles(
  release: NonNullable<AppPublicationOptions['release']>,
  app: string,
) {
  const source = release.sourcePath.replace(/\\/g, '/')
  const treePath = source ? `${source}/${app}` : app
  const { stdout } = await execFile('git', [
    '-C',
    release.root,
    'ls-tree',
    '-rz',
    '--full-tree',
    release.commit,
    '--',
    treePath,
  ])
  const records = stdout.split('\0').filter(Boolean)
  const expected = new Map<string, { mode: number; oid: string }>()
  for (const record of records) {
    const tab = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    if (!mode || !type || !oid) fail(`invalid authenticated app tree: ${app}`)
    const prefix = `${treePath}/`
    if (type !== 'blob' || !path.startsWith(prefix)) fail(`invalid authenticated app tree: ${app}`)
    expected.set(path.slice(prefix.length), { mode: Number.parseInt(mode!, 8), oid: oid! })
  }
  if (!expected.size) fail(`missing authenticated app tree: ${app}`)
  return expected
}

export async function publishApps(
  apps: readonly string[],
  codeDir: string,
  vaultRoot: string,
  options: AppPublicationOptions = {},
): Promise<string[]> {
  if (!apps.length) return []
  const names = apps.map((app) => basename(app))
  if (new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size !== names.length)
    fail('app paths have colliding destination names')
  const root = await realpath(codeDir)
  const vault = await realpath(vaultRoot)
  const holi = join(vault, '.holi')
  const state = join(holi, 'state')
  for (const dir of [holi, state]) {
    try {
      await mkdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe app staging path')
  }
  const holiId = inode(await lstat(holi))
  const stateId = inode(await lstat(state))
  const stageRoot = join(state, `community-apps.local.${randomUUID()}`)
  await mkdir(stageRoot, { mode: 0o700 })
  const stageIdentity = inode(await lstat(stageRoot))
  const published: string[] = []
  const ensureAnchors = async () => {
    await check(options)
    if (
      inode(await lstat(holi)) !== holiId ||
      inode(await lstat(state)) !== stateId ||
      inode(await lstat(stageRoot)) !== stageIdentity
    )
      fail(`app staging identity changed; retained stage: ${stageRoot}`)
  }
  const safeRemove = async () => {
    try {
      if (
        inode(await lstat(holi)) !== holiId ||
        inode(await lstat(state)) !== stateId ||
        inode(await lstat(stageRoot)) !== stageIdentity
      )
        return
      await rm(stageRoot, { recursive: true, force: true })
    } catch {
      /* retain uncertain material rather than follow a replaced path */
    }
  }
  try {
    for (let index = 0; index < apps.length; index++) {
      await ensureAnchors()
      const app = apps[index]!
      const name = names[index]!
      if (!name.endsWith('.app')) fail(`invalid app folder: ${app}`)
      const from = join(root, app)
      const target = join(vault, name)
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      )
        continue
      const expected = options.release ? await authenticatedFiles(options.release, app) : undefined
      const items: Item[] = []
      const dirs: string[] = []
      const ancestors = new Set<string>()
      let entries = 0
      let bytesTotal = 0
      const walk = async (
        path: string,
        rel: string,
        depth: number,
        lineage: Set<string>,
      ): Promise<void> => {
        await ensureAnchors()
        if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) fail('app exceeds filesystem limits')
        const info = await lstat(path)
        const actual = info.isSymbolicLink() ? await realpath(path) : path
        if (!inside(root, actual)) fail(`app source escapes checkout: ${app}/${rel}`)
        const actualStat = await stat(actual)
        if (actualStat.isDirectory()) {
          if (lineage.has(actual)) fail(`app source symlink cycle: ${app}/${rel}`)
          if (rel) dirs.push(rel)
          const next = new Set(lineage).add(actual)
          for (const entry of (await readdir(actual)).sort())
            await walk(join(actual, entry), rel ? `${rel}/${entry}` : entry, depth + 1, next)
        } else if (actualStat.isFile()) {
          bytesTotal += actualStat.size
          if (bytesTotal > MAX_BYTES) fail('app exceeds filesystem limits')
          const handle = await open(
            actual,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
          )
          let data: Buffer
          try {
            const opened = await handle.stat()
            if (!opened.isFile() || opened.size !== actualStat.size)
              fail(`app file changed while reading: ${rel}`)
            data = Buffer.alloc(opened.size)
            let offset = 0
            while (offset < data.length) {
              await ensureAnchors()
              const read = await handle.read(
                data,
                offset,
                Math.min(64 * 1024, data.length - offset),
                offset,
              )
              if (!read.bytesRead) fail(`app file changed while reading: ${rel}`)
              offset += read.bytesRead
            }
          } finally {
            await handle.close()
          }
          items.push({ path: rel, bytes: data, mode: actualStat.mode & 0o777 })
        } else fail(`special file in app: ${app}/${rel}`)
      }
      await walk(from, '', 0, ancestors)
      if (!items.some((item) => item.path === 'index.html')) fail(`app ${app} has no index.html`)
      if (expected) {
        if (expected.size !== items.length)
          fail(`app tree differs from authenticated release: ${app}`)
        for (const item of items) {
          const file = expected.get(item.path)
          const mode = item.mode & 0o111 ? 0o100755 : 0o100644
          if (
            !file ||
            file.mode !== mode ||
            createHash('sha1')
              .update(`blob ${item.bytes.length}\0`)
              .update(item.bytes)
              .digest('hex') !== file.oid
          )
            fail(`app file differs from authenticated release: ${app}/${item.path}`)
        }
      }
      const stage = join(stageRoot, name)
      for (const dir of dirs) await mkdir(join(stage, dir), { recursive: true })
      for (const item of items) {
        await ensureAnchors()
        const output = join(stage, item.path)
        await mkdir(dirname(output), { recursive: true })
        const handle = await open(output, 'wx', item.mode & 0o777)
        try {
          let offset = 0
          while (offset < item.bytes.length) {
            await ensureAnchors()
            const result = await handle.write(
              item.bytes,
              offset,
              Math.min(64 * 1024, item.bytes.length - offset),
              offset,
            )
            if (!result.bytesWritten) fail('app staging write stalled')
            offset += result.bytesWritten
          }
        } finally {
          await handle.close()
        }
      }
    }
    for (const name of names) {
      await ensureAnchors()
      const target = join(vault, name)
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      )
        continue
      await ensureAnchors()
      try {
        await rename(join(stageRoot, name), target)
        published.push(name)
      } catch (error) {
        if (
          await lstat(target).then(
            () => true,
            () => false,
          )
        )
          continue
        throw error
      }
    }
    await safeRemove()
    return published
  } catch (error) {
    await safeRemove()
    throw error
  } finally {
    await safeRemove()
  }
}
