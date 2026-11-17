import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { CapabilityError } from '../../../main/plugin-api'
import {
  authenticatedTree,
  createGitReader,
  gitModeMatches,
  makeAuthenticatedBlobReader,
} from './skill-release'
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
const check = (options: AppPublicationOptions) => {
  if (options.signal?.aborted) throw new CapabilityError('FORBIDDEN', 'publication cancelled')
}
const authorize = async (options: AppPublicationOptions) => {
  check(options)
  await options.guard?.()
  check(options)
}
const inode = (info: Awaited<ReturnType<typeof lstat>>) =>
  `${info.dev}:${info.ino}:${Number(info.mode) & 0o170000}`
type AppPublicationOptions = {
  guard?: () => void | Promise<void>
  signal?: AbortSignal
  release?: { root: string; commit: string; sourcePath: string }
}
type Item = { path: string; bytes: Buffer; mode: number }

async function validateStage(stage: string, items: readonly Item[]) {
  const expected = new Map(items.map((item) => [item.path, item]))
  const seen = new Set<string>()
  const walk = async (dir: string, prefix: string) => {
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe staged app directory')
    for (const entry of await readdir(dir)) {
      const path = prefix ? `${prefix}/${entry}` : entry
      const absolute = join(dir, entry)
      const child = await lstat(absolute)
      if (child.isDirectory() && !child.isSymbolicLink()) await walk(absolute, path)
      else {
        const item = expected.get(path)
        if (!item || !child.isFile() || child.isSymbolicLink())
          fail('staged app changed before publication')
        const bytes = await readFile(absolute)
        if (!bytes.equals(item!.bytes) || (child.mode & 0o777) !== (item!.mode & 0o777))
          fail('staged app changed before publication')
        seen.add(path)
      }
    }
  }
  await walk(stage, '')
  if (seen.size !== expected.size) fail('staged app changed before publication')
}

async function authenticatedFiles(
  release: NonNullable<AppPublicationOptions['release']>,
  app: string,
  signal?: AbortSignal,
) {
  const source = release.sourcePath.replace(/\\/g, '/')
  const treePath = source ? `${source}/${app}` : app
  const git = createGitReader(release.root, signal)
  const tree = await authenticatedTree(release.root, release.commit, signal)
  const readBlob = makeAuthenticatedBlobReader(git, {
    fileBytes: MAX_BYTES,
    totalBytes: MAX_BYTES,
  })
  const expected = new Map<string, { mode: string; oid: string; bytes: Buffer }>()
  const prefix = `${treePath}/`
  let aggregateBytes = 0
  for (const [path, entry] of tree) {
    if (!path.startsWith(prefix)) continue
    const rel = path.slice(prefix.length)
    const depth = rel.split('/').length
    if (
      expected.size >= MAX_ENTRIES ||
      depth > MAX_DEPTH ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    )
      fail(`invalid authenticated app tree: ${app}`)
    const bytes = await readBlob(entry)
    aggregateBytes += bytes.length
    if (aggregateBytes > MAX_BYTES) fail(`app exceeds filesystem limits: ${app}`)
    expected.set(rel, { mode: entry.mode, oid: entry.oid, bytes })
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
  const snapshots = new Map<string, Item[]>()
  const ensureAnchors = async (fullGuard = false) => {
    check(options)
    if (fullGuard) await authorize(options)
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
      await ensureAnchors(true)
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
      const expected = options.release
        ? await authenticatedFiles(options.release, app, options.signal)
        : undefined
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
        await lstat(path)
        const actual = await realpath(path)
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
          const checkoutBytes = item.bytes
          const crlfBytes = Buffer.from(checkoutBytes.toString('utf8').replace(/\r\n/g, '\n'))
          if (
            !file ||
            !gitModeMatches(file!.mode, item.mode) ||
            (!checkoutBytes.equals(file!.bytes) && !crlfBytes.equals(file!.bytes))
          )
            fail(`app file differs from authenticated release: ${app}/${item.path}`)
          item.bytes = file!.bytes
        }
      }
      snapshots.set(
        name,
        items.map((item) => ({ ...item, bytes: Buffer.from(item.bytes) })),
      )
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
      await ensureAnchors(true)
      await validateStage(join(stageRoot, name), snapshots.get(name) ?? [])
      await ensureAnchors()
      check(options)
      const stagedPath = join(stageRoot, name)
      const stagedIdentity = inode(await lstat(stagedPath))
      try {
        await rename(stagedPath, target)
        if (options.signal?.aborted) {
          const identity = await lstat(target).catch(() => undefined)
          if (identity && inode(identity) === stagedIdentity)
            await rm(target, { recursive: true, force: true })
          throw new CapabilityError('FORBIDDEN', 'publication cancelled')
        }
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
