import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import { CapabilityError } from '../../../main/plugin-api'

export type FileSnapshot = { path: string; bytes: Buffer; mode: number }
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
}

const fail = (message: string): never => {
  throw new CapabilityError('BAD_REQUEST', message)
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== path)
}
const fingerprint = async (path: string): Promise<string | null> => {
  const info = await lstat(path).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    fail(`unsafe destination: ${path}`)
  if (info.isFile()) {
    const bytes = await readFile(path)
    return `f:${info.mode & 0o777}:${createHash('sha256').update(bytes).digest('hex')}`
  }
  const entries = (await readdir(path)).sort()
  const children = await Promise.all(
    entries.map(async (entry) => `${entry}:${await fingerprint(join(path, entry))}`),
  )
  return `d:${info.mode & 0o777}:{${children.join('|')}}`
}

async function snapshotSource(root: string, source: string, name: string): Promise<SkillSnapshot> {
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
  const walk = async (path: string, rel: string, ancestors: Set<string>): Promise<void> => {
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
      for (const entry of await readdir(actual))
        await walk(join(actual, entry), rel ? `${rel}/${entry}` : entry, next)
    } else if (actualStat.isFile()) {
      entries.push(rel)
      files.push({ path: rel, bytes: await readFile(actual), mode: actualStat.mode & 0o777 })
    } else fail(`special file in skill: ${source}/${rel}`)
  }
  const baseStat = await stat(base).catch(() => null)
  if (!baseStat?.isDirectory()) fail(`skill source is not a directory: ${source}`)
  const required = await lstat(join(base, 'SKILL.md')).catch(() => null)
  if (!required?.isFile() || required.isSymbolicLink())
    fail(`skill ${source} has no regular SKILL.md`)
  await walk(base, '', new Set())
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
    guard: () => void
    /** Validates detached copies of the exact bytes and modes that the private snapshot will publish. */
    validateSnapshot?: (snapshots: readonly SkillSnapshot[]) => Promise<void> | void
  },
): Promise<string[]> {
  const root = await realpath(codeDir)
  const vault = await realpath(vaultRoot)
  const names = sources.map(({ name }) => name)
  if (new Set(names.map((name) => name.toLocaleLowerCase('en-US'))).size !== names.length)
    fail('declared skills have colliding destinations')
  const snapshots: SkillSnapshot[] = []
  for (const source of sources) snapshots.push(await snapshotSource(root, source.path, source.name))
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
  const plans: Plan[] = []
  for (const { name } of sources) {
    const targetRel = `${destinationRel}/${name}`
    const target =
      (await exactPath(vault, targetRel)) ?? fail(`unsafe skill destination: ${targetRel}`)
    const before = await fingerprint(target)
    const snapshot = snapshotByName.get(name)!
    plans.push({ name, files: snapshot.files, directories: snapshot.directories, target, before })
  }
  const differs = async (plan: Plan) => {
    if (plan.before === null) return true
    const targetFiles: FileSnapshot[] = []
    const targetDirectories: string[] = []
    const targetEntries: string[] = []
    const walk = async (path: string, prefix: string) => {
      for (const entry of await readdir(path)) {
        const abs = join(path, entry),
          rel = prefix ? `${prefix}/${entry}` : entry,
          info = await lstat(abs)
        if (info.isDirectory()) {
          targetEntries.push(rel)
          targetDirectories.push(rel)
          await walk(abs, rel)
        } else if (info.isFile() && !info.isSymbolicLink()) {
          targetEntries.push(rel)
          targetFiles.push({ path: rel, bytes: await readFile(abs), mode: info.mode & 0o777 })
        } else fail(`unsafe destination: ${abs}`)
      }
    }
    await walk(plan.target, '')
    const foldedEntries = targetEntries.map((entry) => entry.toLocaleLowerCase('en-US'))
    if (new Set(foldedEntries).size !== foldedEntries.length)
      fail(`case-colliding destination entries: ${plan.name}`)
    return (
      targetFiles.length !== plan.files.length ||
      targetDirectories.length !== plan.directories.length ||
      plan.directories.some((directory) => !targetDirectories.includes(directory)) ||
      plan.files.some((file) => {
        const found = targetFiles.find((item) => item.path === file.path)
        return !found || found.mode !== file.mode || !found.bytes.equals(file.bytes)
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
  options.guard()
  if (!changed.length) return []
  if ((await exactPath(vault, `.holi/state/${basename(stage)}`)) !== stage)
    fail('unsafe skill staging path')
  await mkdir(dirname(stage), { recursive: true })
  await mkdir(stage)
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
      options.guard()
      if ((await fingerprint(plan.target)) !== plan.before)
        fail(`skill destination changed during refresh: ${plan.name}`)
      // Recheck all destination paths immediately before each publish.
      if ((await exactPath(vault, `${destinationRel}/${plan.name}`)) !== plan.target)
        fail(`unsafe skill destination: ${plan.name}`)
      if (plan.before !== null) {
        await rename(record.target, record.backup)
        record.backedUp = true
      }
      options.guard()
      if ((await exactPath(vault, `${destinationRel}/${plan.name}`)) !== plan.target)
        fail(`unsafe skill destination: ${plan.name}`)
      await rename(record.staged, record.target)
      record.published = true
    }
    options.guard()
  } catch (error) {
    let rollbackFailure: unknown
    for (const record of [...records].reverse()) {
      try {
        // Rollback deliberately ignores cancellation, but never follows a replaced parent.
        const targetRel = relative(vault, record.target).split(sep).join('/')
        const parentRel = relative(vault, dirname(record.target)).split(sep).join('/')
        const parent = await exactPath(vault, parentRel)
        if (parent !== dirname(record.target))
          throw Error('destination parent replaced during rollback')
        if (record.published) {
          if ((await exactPath(vault, targetRel)) !== record.target)
            throw Error('destination replaced during rollback')
          await rm(record.target, { recursive: true, force: true })
        }
        if (record.backedUp) await rename(record.backup, record.target)
      } catch (failure) {
        rollbackFailure ??= failure
      }
    }
    if (rollbackFailure)
      throw new Error(
        `skill refresh failed (${String(error)}); rollback incomplete; recovery files preserved at ${relative(vault, stage).split(sep).join('/')}: ${String(rollbackFailure)}`,
      )
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rm(stage, { recursive: true, force: true })
  } catch (error) {
    throw new Error(
      `skill refresh committed but staging cleanup failed; recoverable files may remain at ${relative(vault, stage).split(sep).join('/')}: ${String(error)}`,
    )
  }
  return changed.map(({ name }) => `${destinationRel}/${name}`)
}
