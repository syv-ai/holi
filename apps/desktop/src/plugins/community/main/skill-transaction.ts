import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

/**
 * Internal filesystem seam used to deterministically exercise transaction failures.
 * @public
 */
export const skillTransactionFs = { rename }
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError } from '../../../main/plugin-api'

type FileSnapshot = { path: string; bytes: Buffer; mode: number }
export type SkillSnapshot = { name: string; files: FileSnapshot[]; directories: string[] }
type Plan = {
  name: string
  files: FileSnapshot[]
  directories: string[]
  target: string
  before: string | null
}
type Record = {
  target: string
  backup: string
  staged: string
  backedUp: boolean
  published: boolean
  publishedFingerprint?: string
  publishedIdentity?: string
  originalIdentity?: string
  originalFingerprint?: string
}

const fail = (message: string): never => {
  throw new CapabilityError('BAD_REQUEST', message)
}

// A release must remain small enough to inspect and stage without unbounded work.
const MAX_FILES = 256
const MAX_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 24
const MAX_ENTRIES = MAX_FILES * 2
const EXECUTABLE = 0o111
const operation = () => ({ files: 0, entries: 0, bytes: 0 })
type Budget = ReturnType<typeof operation>
const consumeEntry = (budget: Budget, depth: number) => {
  if (depth > MAX_DEPTH || ++budget.entries > MAX_ENTRIES) fail('skill exceeds filesystem limits')
}
const readBounded = async (path: string, expectedSize?: number): Promise<Buffer> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.size > MAX_BYTES ||
      (expectedSize !== undefined && info.size !== expectedSize)
    )
      fail(`skill file exceeds limits or differs from authenticated metadata: ${path}`)
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) fail(`skill file changed while reading: ${path}`)
      offset += bytesRead
    }
    if ((await handle.stat()).size !== info.size) fail(`skill file changed while reading: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}
const identity = (info: Awaited<ReturnType<typeof lstat>>) => {
  // If the filesystem cannot attest identity, refuse later destructive recovery actions.
  if (Number(info.dev) === 0 || Number(info.ino) === 0) return `unattested:${randomUUID()}`
  return `${info.dev}:${info.ino}:${Number(info.mode) & 0o170000}`
}
const treeIdentity = async (root: string): Promise<string[]> => {
  const result: string[] = []
  let entries = 0
  const walk = async (path: string, rel = '', depth = 0): Promise<void> => {
    if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) fail('staged skill exceeds filesystem limits')
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      fail(`unsafe staged skill entry: ${path}`)
    result.push(`${rel}:${identity(info)}:${info.mode & 0o777}`)
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        await walk(join(path, entry), rel ? `${rel}/${entry}` : entry, depth + 1)
    }
  }
  await walk(root)
  return result
}
const sameSnapshot = (left: SkillSnapshot, right: SkillSnapshot) =>
  left.files.length === right.files.length &&
  left.directories.length === right.directories.length &&
  right.directories.every((dir) => left.directories.includes(dir)) &&
  right.files.every((file) => {
    const actual = left.files.find(({ path }) => path === file.path)
    return actual !== undefined && actual.mode === file.mode && actual.bytes.equals(file.bytes)
  })
const validateExpectedSnapshot = (snapshot: SkillSnapshot) => {
  if (
    !snapshot.name ||
    snapshot.files.length > MAX_FILES ||
    snapshot.directories.length > MAX_ENTRIES
  )
    fail('authenticated skill metadata exceeds filesystem limits')
  const paths = [...snapshot.files.map(({ path }) => path), ...snapshot.directories]
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        path.split('/').length > MAX_DEPTH,
    )
  )
    fail('invalid authenticated skill metadata shape')
  if (snapshot.files.reduce((total, file) => total + file.bytes.length, 0) > MAX_BYTES)
    fail('authenticated skill metadata exceeds filesystem limits')
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== path)
}
const fingerprint = async (
  path: string,
  budget = operation(),
  depth = 0,
  guard: () => void | Promise<void> = () => {},
): Promise<string | null> => {
  const info = await lstat(path).catch(() => null)
  if (!info) return null
  consumeEntry(budget, depth)
  if (budget.entries % 16 === 0) await guard()
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    fail(`unsafe destination: ${path}`)
  if (info.isFile()) {
    if (++budget.files > MAX_FILES || (budget.bytes += info.size) > MAX_BYTES)
      fail(`skill destination exceeds filesystem limits: ${path}`)
    const bytes = await readBounded(path, info.size)
    return `f:${process.platform === 'win32' ? Number(Boolean(info.mode & EXECUTABLE)) : info.mode & EXECUTABLE}:${createHash('sha256').update(bytes).digest('hex')}`
  }
  const entries = (await readdir(path)).sort()
  const children: string[] = []
  for (const entry of entries)
    children.push(`${entry}:${await fingerprint(join(path, entry), budget, depth + 1, guard)}`)
  return `d:{${children.join('|')}}`
}

async function snapshotSource(
  root: string,
  source: string,
  name: string,
  expected: SkillSnapshot | undefined,
  budget = operation(),
  guard: () => void | Promise<void> = () => {},
): Promise<SkillSnapshot> {
  if (
    source.startsWith('/') ||
    /^[A-Za-z]:/.test(source) ||
    source.includes('\\') ||
    source.split('/').some((part) => part === '..' || part === '.' || part === '') ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  )
    fail(`invalid skill source path: ${source}`)
  const rootReal = await realpath(root)
  const base = (await exactPath(rootReal, source)) ?? fail(`unsafe skill source path: ${source}`)
  if (base !== join(rootReal, source)) fail(`unsafe skill source path: ${source}`)
  const files: FileSnapshot[] = []
  const directories: string[] = []
  const entries: string[] = []
  const expectedFiles = new Map(expected?.files.map((file) => [file.path, file]))
  const expectedDirs = new Set(expected?.directories ?? [])
  if (expected) {
    const seenFiles = new Set<string>()
    const seenDirs = new Set<string>()
    let inspected = 0
    const inspect = async (
      path: string,
      rel: string,
      ancestors: Set<string>,
      depth: number,
    ): Promise<void> => {
      if (depth > MAX_DEPTH || ++inspected > MAX_ENTRIES) fail('skill exceeds filesystem limits')
      if (inspected % 16 === 0) await guard()
      const info = await lstat(path)
      const actual = info.isSymbolicLink() ? await realpath(path) : path
      if (!inside(rootReal, actual)) fail(`skill source escapes plugin: ${source}/${rel}`)
      const actualStat = await stat(actual)
      if (actualStat.isDirectory()) {
        if (rel) {
          if (!expectedDirs.has(rel)) fail(`undeclared directory in skill source: ${source}/${rel}`)
          seenDirs.add(rel)
        }
        if (ancestors.has(actual)) fail(`skill source symlink cycle: ${source}/${rel}`)
        const next = new Set(ancestors).add(actual)
        for (const entry of (await readdir(actual)).sort())
          await inspect(join(actual, entry), rel ? `${rel}/${entry}` : entry, next, depth + 1)
      } else if (actualStat.isFile()) {
        if (!expectedFiles.has(rel)) fail(`undeclared file in skill source: ${source}/${rel}`)
        seenFiles.add(rel)
      } else fail(`special file in skill: ${source}/${rel}`)
    }
    await inspect(base, '', new Set(), 0)
    if (seenFiles.size !== expected.files.length || seenDirs.size !== expected.directories.length)
      fail(`skill source shape differs from authenticated metadata: ${source}`)
  }
  const walk = async (
    path: string,
    rel: string,
    ancestors: Set<string>,
    depth = 0,
  ): Promise<void> => {
    consumeEntry(budget, depth)
    if (budget.entries % 16 === 0) await guard()
    if (expected && rel && !expectedFiles.has(rel) && !expectedDirs.has(rel))
      fail(`undeclared file in skill source: ${source}/${rel}`)
    const info = await lstat(path)
    const actual = info.isSymbolicLink() ? await realpath(path) : path
    if (!inside(rootReal, actual)) fail(`skill source escapes plugin: ${source}/${rel}`)
    const actualStat = await stat(actual)
    if (actualStat.isDirectory()) {
      if (rel) {
        directories.push(rel)
        entries.push(rel)
      }
      if (ancestors.has(actual)) fail(`skill source symlink cycle: ${source}/${rel}`)
      const next = new Set(ancestors).add(actual)
      for (const entry of (await readdir(actual)).sort())
        await walk(join(actual, entry), rel ? `${rel}/${entry}` : entry, next, depth + 1)
    } else if (actualStat.isFile()) {
      entries.push(rel)
      const expectedFile = expectedFiles.get(rel)
      if (expected && !expectedFile) fail(`undeclared file in skill source: ${source}/${rel}`)
      if (++budget.files > MAX_FILES || (budget.bytes += actualStat.size) > MAX_BYTES)
        fail(`skill source exceeds filesystem limits: ${source}`)
      await guard()
      const bytes = await readBounded(actual, expectedFile?.bytes.length)
      if (expectedFile && !bytes.equals(expectedFile.bytes))
        fail(`skill source differs from authenticated metadata: ${source}/${rel}`)
      files.push({ path: rel, bytes, mode: actualStat.mode & 0o777 })
    } else fail(`special file in skill: ${source}/${rel}`)
  }
  const baseStat = await stat(base).catch(() => null)
  if (!baseStat?.isDirectory()) fail(`skill source is not a directory: ${source}`)
  const required = await lstat(join(base, 'SKILL.md')).catch(() => null)
  if (!required?.isFile() || required.isSymbolicLink())
    fail(`skill ${source} has no regular SKILL.md`)
  await walk(base, '', new Set())
  if (
    expected &&
    (files.length !== expected.files.length || directories.length !== expected.directories.length)
  )
    fail(`skill source shape differs from authenticated metadata: ${source}`)
  const folded = entries.map((path) => path.toLocaleLowerCase('en-US'))
  if (new Set(folded).size !== folded.length) fail(`case-colliding entries in skill: ${source}`)
  return { name, files, directories }
}

async function writeSnapshot(snapshot: SkillSnapshot, path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  for (const directory of snapshot.directories)
    await mkdir(join(path, directory), { recursive: true })
  for (const file of snapshot.files) {
    const target = join(path, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes, { mode: file.mode })
    await chmod(target, file.mode)
  }
}

/** Snapshot, validate and publish skills with guarded rollback for observed failures (not crash-atomic). */
export async function transactSkillRefresh(
  sources: readonly { path: string; name: string }[],
  codeDir: string,
  vaultRoot: string,
  options: {
    force: boolean
    guard: () => void | Promise<void>
    /** Authenticated Git snapshot metadata; undeclared source entries are rejected before opening files. */
    expectedSnapshots?: readonly SkillSnapshot[]
    /** Validates detached copies of the exact bytes and modes that the private snapshot will publish. */
    validateSnapshot?: (snapshots: readonly SkillSnapshot[]) => Promise<void> | void
  },
): Promise<string[]> {
  const root = await realpath(codeDir)
  const vault = await realpath(vaultRoot)
  const names = sources.map(({ name }) => name)
  if (names.length > 64) fail('too many declared skills')
  if (new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size !== names.length)
    fail('declared skills have colliding destinations')
  const expectedByName = options.expectedSnapshots
    ? new Map(options.expectedSnapshots.map((snapshot) => [snapshot.name, snapshot]))
    : undefined
  if (
    expectedByName &&
    (expectedByName.size !== sources.length ||
      sources.some(({ name }) => !expectedByName.has(name)))
  )
    fail('authenticated skill metadata does not match declared skills')
  if (options.expectedSnapshots) {
    let files = 0,
      bytes = 0,
      entries = 0
    for (const snapshot of options.expectedSnapshots) {
      validateExpectedSnapshot(snapshot)
      files += snapshot.files.length
      bytes += snapshot.files.reduce((total, file) => total + file.bytes.length, 0)
      entries += snapshot.files.length + snapshot.directories.length
    }
    if (files > MAX_FILES || bytes > MAX_BYTES || entries > MAX_ENTRIES)
      fail('authenticated skill metadata exceeds operation limits')
  }
  const sourceBudget = operation()
  const snapshots: SkillSnapshot[] = []
  for (const source of sources) {
    const expected = expectedByName?.get(source.name)
    if (expected) validateExpectedSnapshot(expected)
    snapshots.push(
      await snapshotSource(root, source.path, source.name, expected, sourceBudget, options.guard),
    )
  }
  const snapshotByName = new Map(snapshots.map((item) => [item.name, item]))
  const destinationRel = '.claude/skills'
  for (const rel of ['.claude', destinationRel]) {
    const path = (await exactPath(vault, rel)) ?? fail('unsafe skill destination path')
    const info = await lstat(path).catch(() => null)
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      fail('unsafe skill destination path')
  }
  const destination =
    (await exactPath(vault, destinationRel)) ?? fail('unsafe skill destination path')
  const stageRel = `.holi/state/community-skills.local.${randomUUID()}`
  const stage = (await exactPath(vault, stageRel)) ?? fail('unsafe skill staging path')
  for (const rel of ['.holi', '.holi/state']) {
    const path = (await exactPath(vault, rel)) ?? fail('unsafe skill staging path')
    const info = await lstat(path).catch(() => null)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('unsafe skill staging path')
  }
  let stageIdentities: string[] | undefined
  let stageIdentity: string | undefined
  const assertStage = async () => {
    const parts = ['.holi', '.holi/state']
    for (let index = 0; index < parts.length; index++) {
      const path =
        (await exactPath(vault, parts[index]!)) ??
        fail('unsafe skill staging ancestry; recovery files preserved')
      if (path !== join(vault, parts[index]!))
        fail('unsafe skill staging ancestry; recovery files preserved')
      const info =
        (await lstat(path).catch(() => null)) ??
        fail('unsafe skill staging ancestry; recovery files preserved')
      if (!info.isDirectory() || info.isSymbolicLink())
        fail('unsafe skill staging ancestry; recovery files preserved')
      if (stageIdentities && identity(info) !== stageIdentities[index])
        fail('skill staging ancestry changed; recovery files preserved')
    }
    if ((await exactPath(vault, stageRel)) !== stage)
      fail('unsafe skill staging path; recovery files preserved')
    if (stageIdentity) {
      const info = await lstat(stage).catch(() => null)
      if (!info?.isDirectory() || info.isSymbolicLink() || identity(info) !== stageIdentity)
        fail('skill staging directory changed; recovery files preserved')
    }
  }
  const plans: Plan[] = []
  for (const { name } of sources) {
    const targetRel = `${destinationRel}/${name}`
    const target =
      (await exactPath(vault, targetRel)) ?? fail(`unsafe skill destination: ${targetRel}`)
    const before = await fingerprint(target, operation(), 0, options.guard)
    const snapshot = snapshotByName.get(name)!
    plans.push({ name, files: snapshot.files, directories: snapshot.directories, target, before })
  }
  const differs = async (plan: Plan) => {
    if (plan.before === null) return true
    const targetFiles = new Map<string, { mode: number; bytes: Buffer }>()
    const targetDirectories: string[] = []
    const targetEntries: string[] = []
    const budget = operation()
    const walk = async (path: string, prefix: string, depth = 0): Promise<void> => {
      if (budget.entries > 0 && budget.entries % 16 === 0) await options.guard()
      for (const entry of (await readdir(path)).sort()) {
        const abs = join(path, entry),
          rel = prefix ? `${prefix}/${entry}` : entry,
          info = await lstat(abs)
        consumeEntry(budget, depth + 1)
        targetEntries.push(rel)
        if (info.isDirectory() && !info.isSymbolicLink()) {
          targetDirectories.push(rel)
          await walk(abs, rel, depth + 1)
        } else if (info.isFile() && !info.isSymbolicLink()) {
          if (++budget.files > MAX_FILES || (budget.bytes += info.size) > MAX_BYTES)
            fail(`skill destination exceeds filesystem limits: ${plan.name}`)
          targetFiles.set(rel, {
            mode: info.mode & 0o777,
            bytes: await readBounded(abs, info.size),
          })
        } else fail(`unsafe destination: ${abs}`)
      }
    }
    await walk(plan.target, '')
    const foldedEntries = targetEntries.map((entry) => entry.toLocaleLowerCase('en-US'))
    if (new Set(foldedEntries).size !== foldedEntries.length)
      fail(`case-colliding destination entries: ${plan.name}`)
    return (
      targetFiles.size !== plan.files.length ||
      targetDirectories.length !== plan.directories.length ||
      plan.directories.some((directory) => !targetDirectories.includes(directory)) ||
      plan.files.some((file) => {
        const found = targetFiles.get(file.path)
        return (
          !found ||
          (process.platform !== 'win32' &&
            Boolean(found.mode & EXECUTABLE) !== Boolean(file.mode & EXECUTABLE)) ||
          !found.bytes.equals(file.bytes)
        )
      })
    )
  }
  const changed: Plan[] = []
  for (const plan of plans) {
    if (plan.before === null || (await differs(plan))) changed.push(plan)
  }
  if (!options.force && changed.some((plan) => plan.before !== null))
    throw new CapabilityError(
      'CONFLICT',
      'one or more skill folders differ; use --force to replace complete folders',
    )
  await options.validateSnapshot?.(
    snapshots.map(({ name, directories, files }) => ({
      name,
      directories: [...directories],
      files: files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
    })),
  )
  await options.guard()
  if (!changed.length) return []
  if ((await exactPath(vault, `.holi/state/${basename(stage)}`)) !== stage)
    fail('unsafe skill staging path')
  await mkdir(dirname(stage), { recursive: true })
  for (const rel of ['.holi', '.holi/state']) {
    const path = (await exactPath(vault, rel)) ?? fail('unsafe skill staging ancestry')
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe skill staging ancestry')
  }
  stageIdentities = await Promise.all(
    ['.holi', '.holi/state'].map(async (rel) => identity(await lstat(join(vault, rel)))),
  )
  await mkdir(stage, { mode: 0o700 })
  await chmod(stage, 0o700)
  stageIdentity = identity(await lstat(stage))
  await assertStage()
  const records: Record[] = changed.map((plan) => ({
    target: plan.target,
    backup: `${stage}/${plan.name}.original`,
    staged: `${stage}/${plan.name}.new`,
    backedUp: false,
    published: false,
  }))
  try {
    for (let i = 0; i < changed.length; i++) await writeSnapshot(changed[i]!, records[i]!.staged)
    if ((await exactPath(vault, destinationRel)) !== destination)
      fail('unsafe skill destination path')
    await mkdir(destination, { recursive: true })
    for (let i = 0; i < changed.length; i++) {
      const plan = changed[i]!,
        record = records[i]!
      await options.guard()
      if ((await fingerprint(plan.target)) !== plan.before)
        fail(`skill destination changed during refresh: ${plan.name}`)
      // Guard callbacks can mutate staging; validate the exact private snapshot afterward.
      await assertStage()
      const stagedSnapshot = await snapshotSource(
        dirname(stage),
        `${basename(stage)}/${plan.name}.new`,
        plan.name,
        { name: plan.name, files: plan.files, directories: plan.directories },
      ).catch(() => fail(`staged skill changed before publication: ${plan.name}`))
      if (
        !sameSnapshot(stagedSnapshot, {
          name: plan.name,
          files: plan.files,
          directories: plan.directories,
        })
      )
        fail(`staged skill changed before publication: ${plan.name}`)
      if ((await exactPath(vault, stageRel)) !== stage) fail('unsafe skill staging path')
      if ((await exactPath(vault, `${destinationRel}/${plan.name}`)) !== plan.target)
        fail(`unsafe skill destination: ${plan.name}`)
      if (plan.before !== null) {
        record.originalIdentity = identity(await lstat(record.target))
        record.originalFingerprint = plan.before
        await skillTransactionFs.rename(record.target, record.backup)
        record.backedUp = true
      }
      await options.guard()
      await assertStage()
      if (await lstat(record.target).catch(() => null))
        fail(`skill destination appeared before publication: ${plan.name}`)
      const stagedAfterGuard = await snapshotSource(
        dirname(stage),
        `${basename(stage)}/${plan.name}.new`,
        plan.name,
        { name: plan.name, files: plan.files, directories: plan.directories },
      ).catch(() => fail(`staged skill changed before publication: ${plan.name}`))
      if (
        !sameSnapshot(stagedAfterGuard, {
          name: plan.name,
          files: plan.files,
          directories: plan.directories,
        })
      )
        fail(`staged skill changed before publication: ${plan.name}`)
      const verifiedStageIdentity = await treeIdentity(record.staged)
      if ((await exactPath(vault, `${destinationRel}/${plan.name}`)) !== plan.target)
        fail(`unsafe skill destination: ${plan.name}`)
      if (
        JSON.stringify(await treeIdentity(record.staged)) !== JSON.stringify(verifiedStageIdentity)
      )
        fail(`staged skill identity changed before publication: ${plan.name}`)
      record.publishedFingerprint =
        (await fingerprint(record.staged)) ??
        fail(`staged skill disappeared before publication: ${plan.name}`)
      record.publishedIdentity = identity(await lstat(record.staged))
      await skillTransactionFs.rename(record.staged, record.target)
      record.published = true
      if (identity(await lstat(record.target)) !== record.publishedIdentity)
        fail(`published skill identity changed: ${plan.name}`)
    }
    await options.guard()
  } catch (error) {
    let rollbackFailure: unknown
    for (const record of [...records].reverse()) {
      if (!record.published && !record.backedUp) continue
      try {
        // Rollback deliberately ignores cancellation, but never follows a replaced parent.
        const targetRel = relative(vault, record.target).split(sep).join('/')
        const parentRel = relative(vault, dirname(record.target)).split(sep).join('/')
        await assertStage()
        const parent = await exactPath(vault, parentRel)
        if (parent !== dirname(record.target))
          throw Error('destination parent replaced during rollback')
        if (record.published) {
          if ((await exactPath(vault, targetRel)) !== record.target)
            throw Error('destination replaced during rollback')
          const currentInfo = await lstat(record.target)
          if (
            identity(currentInfo) !== record.publishedIdentity ||
            (await fingerprint(record.target)) !== record.publishedFingerprint
          )
            throw Error(
              'published destination changed during rollback; current target and original backup preserved',
            )
          await assertStage()
          await rm(record.target, { recursive: true, force: true })
        }
        if (record.backedUp) {
          await assertStage()
          const backupInfo = await lstat(record.backup)
          if (
            identity(backupInfo) !== record.originalIdentity ||
            (await fingerprint(record.backup)) !== record.originalFingerprint
          )
            throw Error('original backup changed during refresh; recovery data preserved')
          const currentTarget = await lstat(record.target).catch(() => null)
          if (!record.published && currentTarget)
            throw Error('destination appeared before backup restoration; recovery data preserved')
          await skillTransactionFs.rename(record.backup, record.target)
        }
      } catch (failure) {
        rollbackFailure ??= failure
      }
    }
    if (rollbackFailure)
      throw new Error(
        `skill refresh failed (${String(error)}); rollback incomplete; recovery files preserved at ${relative(vault, stage).split(sep).join('/')}: ${String(rollbackFailure)}`,
      )
    try {
      await assertStage()
      await rm(stage, { recursive: true, force: true })
    } catch (cleanupFailure) {
      throw new Error(
        `skill refresh failed (${String(error)}); staging cleanup failed; recovery files preserved at ${relative(vault, stage).split(sep).join('/')}: ${String(cleanupFailure)}`,
      )
    }
    throw error
  }
  try {
    await assertStage()
    await rm(stage, { recursive: true, force: true })
  } catch (error) {
    throw new Error(
      `skill refresh committed but staging cleanup failed; recoverable files may remain at ${relative(vault, stage).split(sep).join('/')}: ${String(error)}`,
    )
  }
  return changed.map(({ name }) => `${destinationRel}/${name}`)
}
