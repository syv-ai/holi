import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { devNull } from 'node:os'
import { PLUGIN_PINS_DIR, parsePluginPin } from '@holi/shared'
import type { SkillSnapshot } from './skill-transaction'

const execFile = promisify(execFileCallback)
const MAX_TREE_BYTES = 16 * 1024 * 1024
const MAX_TREE_ENTRIES = 10_000
const MAX_BLOB_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BLOB_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_FILES = 5_000
const MAX_SKILLS = 100
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const MAX_PATH_DEPTH = 32
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024

type GitReader = {
  read(args: string[], maxBuffer?: number): Promise<Buffer>
}

function createGitReader(root: string): GitReader {
  return {
    async read(args, maxBuffer = MAX_GIT_OUTPUT_BYTES) {
      const safeEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      )
      let result
      try {
        result = await execFile(
          'git',
          [
            '--no-replace-objects',
            '-c',
            'core.fsmonitor=false',
            '-c',
            `core.hooksPath=${devNull}`,
            ...args,
          ],
          {
            cwd: root,
            env: {
              ...safeEnv,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: devNull,
              GIT_NO_REPLACE_OBJECTS: '1',
              GIT_TERMINAL_PROMPT: '0',
            },
            encoding: 'buffer',
            maxBuffer,
          },
        )
      } catch (error) {
        if (String(error).includes('maxBuffer'))
          throw new Error('Git verification output exceeds limit')
        throw error
      }
      return result.stdout
    },
  }
}

function objectId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

interface TreeEntry {
  mode: string
  type: string
  oid: string
  path: string
}

async function tree(git: GitReader, commit: string): Promise<Map<string, TreeEntry>> {
  const raw = await git.read(['ls-tree', '-r', '-z', '--full-tree', commit], MAX_TREE_BYTES)
  const entries = new Map<string, TreeEntry>()
  for (const item of raw.toString('utf8').split('\0')) {
    if (!item) continue
    if (entries.size >= MAX_TREE_ENTRIES) throw new Error('pinned release tree exceeds file limit')
    const tab = item.indexOf('\t')
    const [mode, type, oid] = item.slice(0, tab).split(' ')
    const path = item.slice(tab + 1)
    if (
      !mode ||
      !type ||
      !oid ||
      tab < 0 ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      path.split('/').length > MAX_PATH_DEPTH
    )
      throw new Error('invalid release tree entry')
    entries.set(path, { mode, type, oid, path })
  }
  return entries
}

function cleanPath(path: string): boolean {
  return (
    path !== '' &&
    path.length <= 4_096 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..') &&
    path.split('/').length <= MAX_PATH_DEPTH
  )
}

function makeBlobReader(git: GitReader): (entry: TreeEntry) => Promise<Buffer> {
  const cache = new Map<string, Buffer>()
  let totalBytes = 0
  return async (entry) => {
    const existing = cache.get(entry.oid)
    if (existing) return existing
    const bytes = await git.read(['cat-file', 'blob', entry.oid], MAX_BLOB_BYTES + 1)
    if (bytes.length > MAX_BLOB_BYTES) throw new Error('pinned release blob exceeds file limit')
    totalBytes += bytes.length
    if (totalBytes > MAX_TOTAL_BLOB_BYTES)
      throw new Error('pinned release objects exceed total byte limit')
    if (objectId(bytes) !== entry.oid) throw new Error('invalid Git blob object')
    cache.set(entry.oid, bytes)
    return bytes
  }
}

/** Read-only verification of a private snapshot against immutable Git objects. */
export async function validateSkillSnapshot(
  root: string,
  commit: string,
  sourcePath: string,
  skills: readonly string[],
  snapshots: readonly SkillSnapshot[],
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid pinned commit')
  if (sourcePath && !cleanPath(sourcePath)) throw new Error('invalid plugin source path')
  if (skills.length > MAX_SKILLS || snapshots.length > MAX_SKILLS)
    throw new Error('skill snapshot exceeds count limit')
  if (skills.some((skill) => skill.length > 4_096) || skills.join('').length > 1_000_000)
    throw new Error('pinned skill manifest exceeds path limit')
  let inputBytes = 0
  let totalOutputEntries = 0
  for (const snapshot of snapshots) {
    if (snapshot.files.length > MAX_OUTPUT_FILES || snapshot.directories.length > MAX_OUTPUT_FILES)
      throw new Error('skill snapshot exceeds output limit')
    inputBytes += snapshot.files.reduce((total, file) => total + file.bytes.length, 0)
    totalOutputEntries += snapshot.files.length + snapshot.directories.length
    if (inputBytes > MAX_SNAPSHOT_BYTES || totalOutputEntries > MAX_OUTPUT_FILES)
      throw new Error('skill snapshots exceed verification limits')
    if (
      snapshot.files.some((file) => !cleanPath(file.path)) ||
      snapshot.directories.some((dir) => !cleanPath(dir))
    )
      throw new Error('invalid skill snapshot path')
  }
  const git = createGitReader(root)
  const entries = await tree(git, commit)
  const readBlob = makeBlobReader(git)
  const childrenByDir = new Map<string, Set<string>>()
  for (const path of entries.keys()) {
    const parent = posix.dirname(path)
    const name = posix.basename(path)
    const children = childrenByDir.get(parent) ?? new Set<string>()
    children.add(name)
    childrenByDir.set(parent, children)
    let ancestor = parent
    while (ancestor !== '.') {
      if (!childrenByDir.has(ancestor)) childrenByDir.set(ancestor, new Set())
      const upper = posix.dirname(ancestor)
      const siblings = childrenByDir.get(upper) ?? new Set<string>()
      siblings.add(posix.basename(ancestor))
      childrenByDir.set(upper, siblings)
      ancestor = upper
    }
  }
  const expectedNames = new Set(skills.map((item) => item.split('/').at(-1)))
  if (
    skills.length !== expectedNames.size ||
    snapshots.length !== expectedNames.size ||
    new Set(snapshots.map((snapshot) => snapshot.name)).size !== snapshots.length ||
    snapshots.some((snapshot) => !expectedNames.has(snapshot.name))
  )
    throw new Error('undeclared skill snapshot')

  for (const snapshot of snapshots) {
    const skill = skills.find((item) => item.split('/').at(-1) === snapshot.name)!
    if (!cleanPath(skill)) throw new Error('invalid skill path in pinned manifest')
    const prefix = [sourcePath, skill].filter(Boolean).join('/')
    const expectedFiles = new Map<string, { bytes: Buffer; mode: number }>()
    const expectedDirs = new Set<string>()
    // Resolve path links asynchronously while preserving the virtual output path.
    const resolveLink = async (linkPath: string, seen: Set<string>): Promise<string> => {
      if (!cleanPath(linkPath) || seen.has(linkPath))
        throw new Error('invalid or cyclic skill symlink')
      const entry = entries.get(linkPath)
      if (!entry && childrenByDir.has(linkPath)) return linkPath
      if (!entry || entry.type !== 'blob')
        throw new Error(`skill path absent from pinned tree: ${linkPath}`)
      if (entry.mode !== '120000') return linkPath
      const target = (await readBlob(entry)).toString('utf8')
      if (isAbsolute(target) || target.includes('\\')) throw new Error('unsafe skill symlink')
      const next = posix.normalize(posix.join(posix.dirname(linkPath), target))
      if (
        !cleanPath(next) ||
        (sourcePath && next !== sourcePath && !next.startsWith(`${sourcePath}/`))
      )
        throw new Error('skill symlink escapes plugin')
      return resolveLink(next, new Set(seen).add(linkPath))
    }
    const hasDescendant = (path: string) => childrenByDir.has(path)
    const walk = async (
      physicalDir: string,
      outputDir: string,
      seen: Set<string>,
    ): Promise<void> => {
      const children = childrenByDir.get(physicalDir) ?? new Set<string>()
      for (const child of children) {
        const physical = `${physicalDir}/${child}`
        const output = outputDir ? `${outputDir}/${child}` : child
        const entry = entries.get(physical)
        if (entry && entry.type !== 'blob')
          throw new Error('gitlink or special entry in skill release')
        if (entry?.type === 'blob') {
          if (entry.mode === '120000') {
            const target = await resolveLink(physical, seen)
            if (physical === `${prefix}/SKILL.md` && output === 'SKILL.md')
              throw new Error('required SKILL.md may not be a symlink')
            if (hasDescendant(target)) {
              if (expectedDirs.size + expectedFiles.size >= MAX_OUTPUT_FILES)
                throw new Error('skill snapshot exceeds output limit')
              expectedDirs.add(output)
              await walk(target, output, new Set(seen).add(physical))
            } else {
              const targetEntry = entries.get(target)
              if (!targetEntry || targetEntry.type !== 'blob')
                throw new Error(`skill file absent from pinned tree: ${target}`)
              if (targetEntry.mode === '120000') throw new Error('unresolved skill symlink')
              if (targetEntry.mode !== '100644' && targetEntry.mode !== '100755')
                throw new Error('special skill file in release')
              const bytes = await readBlob(targetEntry)
              expectedFiles.set(output, {
                bytes,
                mode: targetEntry.mode === '100755' ? 0o755 : 0o644,
              })
            }
          } else {
            if (entry.mode !== '100644' && entry.mode !== '100755')
              throw new Error('special skill file in release')
            const bytes = await readBlob(entry)
            expectedFiles.set(output, { bytes, mode: entry.mode === '100755' ? 0o755 : 0o644 })
          }
        } else if (hasDescendant(physical)) {
          if (expectedDirs.size + expectedFiles.size >= MAX_OUTPUT_FILES)
            throw new Error('skill snapshot exceeds output limit')
          expectedDirs.add(output)
          await walk(physical, output, seen)
        }
      }
    }
    if (entries.has(prefix) || !hasDescendant(prefix))
      throw new Error(`required skill is absent from pin: ${snapshot.name}`)
    await walk(prefix, '', new Set())
    if (!expectedFiles.has('SKILL.md'))
      throw new Error(`required skill is absent from pin: ${snapshot.name}`)
    const snapshotFiles = new Set(snapshot.files.map((file) => file.path))
    const snapshotDirs = new Set(snapshot.directories)
    if (
      expectedFiles.size !== snapshot.files.length ||
      snapshotFiles.size !== snapshot.files.length ||
      expectedDirs.size !== snapshot.directories.length ||
      snapshotDirs.size !== snapshot.directories.length ||
      [...expectedFiles.keys()].some((path) => !snapshotFiles.has(path)) ||
      [...expectedDirs].some((path) => !snapshotDirs.has(path))
    )
      throw new Error(`skill snapshot shape differs from pin: ${snapshot.name}`)
    for (const file of snapshot.files) {
      const expected = expectedFiles.get(file.path)
      if (
        !expected ||
        expected.mode !== file.mode ||
        !expected.bytes.equals(file.bytes) ||
        objectId(file.bytes) !== objectId(expected.bytes)
      )
        throw new Error(`skill snapshot differs from pinned bytes: ${snapshot.name}/${file.path}`)
    }
    if (snapshot.directories.some((dir) => !expectedDirs.has(dir)))
      throw new Error(`skill directories differ from pin: ${snapshot.name}`)
  }
}

/** Read pins strictly: a malformed or symlink pin cannot hide a competing claim. */
export async function assertNoCompetingSkillClaims(
  vaultRoot: string,
  id: string,
  skills: readonly string[],
): Promise<void> {
  const pinsDir = join(vaultRoot, PLUGIN_PINS_DIR)
  const dirInfo = await lstat(pinsDir).catch(() => null)
  if (!dirInfo) return
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())
    throw new Error('unsafe plugin pins directory')
  const root = await realpath(vaultRoot)
  for (const entry of await readdir(pinsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('malformed plugin pin entry')
    const file = join(pinsDir, entry.name, 'manifest.json')
    const info = await lstat(file).catch(() => null)
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      resolve(file) !== file ||
      !relative(root, file).startsWith(PLUGIN_PINS_DIR)
    )
      throw new Error('unsafe plugin pin path')
    let parsed
    try {
      parsed = parsePluginPin(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      throw new Error('malformed plugin pin')
    }
    if (!parsed.ok || parsed.value.id !== entry.name)
      throw new Error('malformed plugin pin identity')
    if (parsed.value.id === id) continue
    const claimed = new Set((parsed.value.skills ?? []).map((skill) => skill.split('/').at(-1)))
    if (skills.some((skill) => claimed.has(skill.split('/').at(-1))))
      throw new Error(`skill destination claimed by ${parsed.value.id}`)
  }
}

export async function assertManifestPinned(
  root: string,
  commit: string,
  sourcePath: string,
  manifest: unknown,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit) || (sourcePath && !cleanPath(sourcePath)))
    throw new Error('invalid pinned release identity')
  const git = createGitReader(root)
  const entries = await tree(git, commit)
  const path = [sourcePath, 'holi-plugin.json'].filter(Boolean).join('/')
  const entry = entries.get(path)
  if (!entry || entry.mode !== '100644') throw new Error('manifest absent from pinned Git object')
  const bytes = await makeBlobReader(git)(entry)
  if (JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(manifest))
    throw new Error('manifest differs from pinned Git object')
}
