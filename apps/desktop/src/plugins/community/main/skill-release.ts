import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve } from 'node:path'
import { devNull } from 'node:os'
import { PLUGIN_PINS_DIR, parsePluginPin, parsePluginManifest } from '@holi/shared'
import { readBoundedRegularText } from './fetch'
import type { SkillSnapshot } from './skill-transaction'

const MAX_TREE_BYTES = 16 * 1024 * 1024
const MAX_TREE_ENTRIES = 10_000
const MAX_BLOB_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BLOB_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_FILES = 5_000
const MAX_SKILLS = 100
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const MAX_PATH_DEPTH = 32
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024

export type GitReader = {
  read(args: string[], maxBuffer?: number): Promise<Buffer>
}

const GIT_TIMEOUT_MS = 5_000

export function createGitReader(root: string, signal?: AbortSignal): GitReader {
  return {
    read(args, maxBuffer = MAX_GIT_OUTPUT_BYTES) {
      return new Promise<Buffer>((resolveOutput, reject) => {
        if (signal?.aborted) return reject(new Error('Git verification cancelled'))
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        )
        const child = spawn(
          'git',
          [
            '--no-replace-objects',
            '-c',
            'protocol.allow=never',
            '-c',
            'protocol.ext.allow=never',
            '-c',
            'core.fsmonitor=false',
            '-c',
            `core.hooksPath=${devNull}`,
            '-c',
            'core.attributesFile=',
            ...args,
          ],
          {
            cwd: root,
            env: {
              PATH: env.PATH ?? '/usr/bin:/bin',
              HOME: devNull,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: devNull,
              GIT_NO_REPLACE_OBJECTS: '1',
              GIT_NO_LAZY_FETCH: '1',
              GIT_TERMINAL_PROMPT: '0',
            },
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        )
        const chunks: Buffer[] = []
        let size = 0
        let settled = false
        const finish = (error?: Error, bytes?: Buffer) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          error ? reject(error) : resolveOutput(bytes!)
        }
        const abort = () => child.kill('SIGKILL')
        const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBuffer) {
            child.kill('SIGKILL')
            finish(new Error('Git verification output exceeds limit'))
          } else chunks.push(chunk)
        })
        child.on('error', (error) => finish(error))
        child.on('close', (code) => {
          if (settled) return
          if (signal?.aborted) finish(new Error('Git verification cancelled'))
          else if (code !== 0) finish(new Error('Git verification command failed'))
          else finish(undefined, Buffer.concat(chunks))
        })
      })
    },
  }
}

/**
 * Kept accessible for portable filesystem-mode tests.
 * @public
 */
export function gitModeMatches(
  mode: string,
  filesystemMode: number,
  platform = process.platform,
): boolean {
  if (mode !== '100644' && mode !== '100755') return false
  return platform === 'win32' || Boolean(mode === '100755') === Boolean(filesystemMode & 0o111)
}

function objectId(type: string, bytes: Buffer): string {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex')
}

interface TreeEntry {
  mode: string
  type: string
  oid: string
  path: string
}

export async function authenticatedTree(
  root: string,
  commit: string,
  signal?: AbortSignal,
): Promise<Map<string, TreeEntry>> {
  const git = createGitReader(root, signal)

  const commitBytes = await git.read(['cat-file', 'commit', commit], MAX_BLOB_BYTES)
  if (objectId('commit', commitBytes) !== commit) throw new Error('invalid pinned Git commit')
  const headerEnd = commitBytes.indexOf(Buffer.from('\n\n'))
  if (headerEnd < 0) throw new Error('invalid pinned Git commit headers')
  const headers = commitBytes.subarray(0, headerEnd).toString('ascii')
  const rootTree = /^tree ([0-9a-f]{40})$/m.exec(headers)?.[1]
  if (!rootTree) throw new Error('pinned Git commit has no valid tree')
  const entries = new Map<string, TreeEntry>()
  const seenPaths = new Set<string>()
  let expandedEntries = 0
  let totalTreeBytes = 0
  const authenticatedTrees = new Map<string, Buffer>()
  const readTree = async (
    oid: string,
    parent: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    if (depth > MAX_PATH_DEPTH || ancestors.has(oid)) throw new Error('invalid or cyclic Git tree')
    const nextAncestors = new Set(ancestors).add(oid)
    let raw = authenticatedTrees.get(oid)
    if (raw === undefined) {
      raw = await git.read(['cat-file', 'tree', oid], MAX_TREE_BYTES)
      totalTreeBytes += raw.length
      if (totalTreeBytes > MAX_TREE_BYTES) throw new Error('pinned release trees exceed byte limit')
      if (objectId('tree', raw) !== oid) throw new Error('invalid Git tree object')
      authenticatedTrees.set(oid, raw)
    }
    let offset = 0
    while (offset < raw.length) {
      const space = raw.indexOf(0x20, offset)
      const nul = raw.indexOf(0, space + 1)
      if (space < 0 || nul < 0 || nul + 21 > raw.length) throw new Error('invalid raw Git tree')
      if (++expandedEntries > MAX_TREE_ENTRIES)
        throw new Error('pinned release tree exceeds entry limit')
      const mode = raw.subarray(offset, space).toString('ascii')
      const nameBytes = raw.subarray(space + 1, nul)
      const name = nameBytes.toString('utf8')
      const oidBytes = raw.subarray(nul + 1, nul + 21)
      const childOid = oidBytes.toString('hex')
      const path = parent ? `${parent}/${name}` : name
      if (
        !name ||
        !Buffer.from(name, 'utf8').equals(nameBytes) ||
        name.includes('/') ||
        name === '.' ||
        name === '..' ||
        !cleanPath(path) ||
        seenPaths.has(path)
      )
        throw new Error('unsafe Git tree path')
      const type = mode === '40000' || mode === '040000' ? 'tree' : 'blob'
      if (!['100644', '100755', '120000', '40000', '040000'].includes(mode))
        throw new Error('unsupported Git tree mode')
      let parentPath = parent
      while (parentPath) {
        if (entries.has(parentPath)) throw new Error('Git file collides with tree path')
        parentPath = posix.dirname(parentPath)
        if (parentPath === '.') break
      }
      if (entries.has(path)) throw new Error('duplicate Git tree path')
      seenPaths.add(path)
      if ([...seenPaths].some((candidate) => candidate.startsWith(`${path}/`) && type === 'blob'))
        throw new Error('Git file collides with tree path')
      if (type === 'tree') await readTree(childOid, path, depth + 1, nextAncestors)
      else entries.set(path, { mode, type, oid: childOid, path })
      offset = nul + 21
    }
  }
  await readTree(rootTree, '', 0, new Set())
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

export function makeAuthenticatedBlobReader(
  git: GitReader,
  limits: { fileBytes?: number; totalBytes?: number } = {},
): (entry: TreeEntry) => Promise<Buffer> {
  const cache = new Map<string, Buffer>()
  let totalBytes = 0
  return async (entry) => {
    const existing = cache.get(entry.oid)
    if (existing) return existing
    const fileBytes = limits.fileBytes ?? MAX_BLOB_BYTES
    const totalLimit = limits.totalBytes ?? MAX_TOTAL_BLOB_BYTES
    const bytes = await git.read(['cat-file', 'blob', entry.oid], fileBytes + 1)
    if (bytes.length > fileBytes) throw new Error('pinned release blob exceeds file limit')
    totalBytes += bytes.length
    if (totalBytes > totalLimit) throw new Error('pinned release objects exceed total byte limit')
    if (objectId('blob', bytes) !== entry.oid) throw new Error('invalid Git blob object')
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
  snapshots?: readonly SkillSnapshot[],
  signal?: AbortSignal,
): Promise<SkillSnapshot[]> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid pinned commit')
  if (sourcePath && !cleanPath(sourcePath)) throw new Error('invalid plugin source path')
  if (skills.length > MAX_SKILLS || (snapshots?.length ?? 0) > MAX_SKILLS)
    throw new Error('skill snapshot exceeds count limit')
  if (skills.some((skill) => skill.length > 4_096) || skills.join('').length > 1_000_000)
    throw new Error('pinned skill manifest exceeds path limit')
  let inputBytes = 0
  let totalOutputEntries = 0
  for (const snapshot of snapshots ?? []) {
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
  const git = createGitReader(root, signal)
  const entries = await authenticatedTree(root, commit, signal)
  const readBlob = makeAuthenticatedBlobReader(git)
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
  const actualByName = new Map((snapshots ?? []).map((snapshot) => [snapshot.name, snapshot]))
  if (
    skills.length !== expectedNames.size ||
    (snapshots !== undefined &&
      (snapshots.length !== expectedNames.size ||
        actualByName.size !== snapshots.length ||
        snapshots.some((snapshot) => !expectedNames.has(snapshot.name))))
  )
    throw new Error('undeclared skill snapshot')
  const authenticated: SkillSnapshot[] = []

  for (const skill of skills) {
    const name = skill.split('/').at(-1)!
    const snapshot = actualByName.get(name)
    if (!cleanPath(skill)) throw new Error('invalid skill path in pinned manifest')
    const prefix = [sourcePath, skill].filter(Boolean).join('/')
    const expectedFiles = new Map<string, { bytes: Buffer; mode: number }>()
    const expectedDirs = new Set<string>()
    // Resolve path links asynchronously while preserving the virtual output path.
    const resolveLink = async (linkPath: string, seen: Set<string>): Promise<string> => {
      if (!cleanPath(linkPath)) throw new Error('invalid skill symlink path')
      const parts = linkPath.split('/')
      for (let index = 1; index <= parts.length; index++) {
        const component = parts.slice(0, index).join('/')
        const entry = entries.get(component)
        if (entry?.mode !== '120000') continue
        if (seen.has(component)) throw new Error('invalid or cyclic skill symlink')
        const target = (await readBlob(entry)).toString('utf8')
        if (isAbsolute(target) || target.includes('\\')) throw new Error('unsafe skill symlink')
        const resolvedTarget = posix.normalize(posix.join(posix.dirname(component), target))
        if (
          !cleanPath(resolvedTarget) ||
          (sourcePath &&
            resolvedTarget !== sourcePath &&
            !resolvedTarget.startsWith(`${sourcePath}/`))
        )
          throw new Error('skill symlink escapes plugin')
        const suffix = parts.slice(index).join('/')
        const combined = suffix ? `${resolvedTarget}/${suffix}` : resolvedTarget
        return resolveLink(combined, new Set(seen).add(component))
      }
      if (entries.has(linkPath)) return linkPath
      if (childrenByDir.has(linkPath)) return linkPath
      throw new Error(`skill path absent from pinned tree: ${linkPath}`)
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
      throw new Error(`required skill is absent from pin: ${name}`)
    await walk(prefix, '', new Set())
    if (!expectedFiles.has('SKILL.md'))
      throw new Error(`required skill is absent from pin: ${name}`)
    const expectedSnapshot: SkillSnapshot = {
      name,
      directories: [...expectedDirs],
      files: [...expectedFiles].map(([path, file]) => ({
        path,
        bytes: file.bytes,
        mode: file.mode,
      })),
    }
    authenticated.push(expectedSnapshot)
    if (snapshot !== undefined) {
      const snapshotFiles = new Set(snapshot.files.map((file) => file.path))
      const snapshotDirs = new Set(snapshot.directories)
      if (
        expectedFiles.size !== snapshot.files.length ||
        snapshotFiles.size !== snapshot.files.length ||
        expectedDirs.size !== snapshot.directories.length ||
        snapshotDirs.size !== snapshot.directories.length ||
        [...expectedFiles.keys()].some((path) => !snapshotFiles.has(path)) ||
        [...expectedDirs].some((dir) => !snapshotDirs.has(dir))
      )
        throw new Error(`skill snapshot shape differs from pin: ${name}`)
      for (const file of snapshot.files) {
        const expected = expectedFiles.get(file.path)
        if (
          !expected ||
          !gitModeMatches(expected?.mode === 0o755 ? '100755' : '100644', file.mode) ||
          !expected.bytes.equals(file.bytes) ||
          objectId('blob', file.bytes) !== objectId('blob', expected.bytes)
        )
          throw new Error(`skill snapshot differs from pinned bytes: ${name}/${file.path}`)
      }
      if (snapshot.directories.some((dir) => !expectedDirs.has(dir)))
        throw new Error(`skill directories differ from pin: ${name}`)
    }
  }
  return authenticated
}

export async function readPinnedSkillSnapshots(
  root: string,
  commit: string,
  sourcePath: string,
  skills: readonly string[],
  signal?: AbortSignal,
): Promise<SkillSnapshot[]> {
  return validateSkillSnapshot(root, commit, sourcePath, skills, undefined, signal)
}

/** Read pins strictly: a malformed or symlink pin cannot hide a competing claim. */
export async function assertNoCompetingSkillClaims(
  vaultRoot: string,
  id: string,
  skills: readonly string[],
  options: { allowIncompleteOwnPin?: boolean } = {},
): Promise<void> {
  const root = await realpath(vaultRoot)
  const pinsDir = join(root, PLUGIN_PINS_DIR)
  const dirInfo = await lstat(pinsDir).catch(() => null)
  if (!dirInfo) return
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())
    throw new Error('unsafe plugin pins directory')
  for (const entry of await readdir(pinsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('malformed plugin pin entry')
    const file = join(pinsDir, entry.name, 'manifest.json')
    const info = await lstat(file).catch(() => null)
    if (!info && entry.name === id && options.allowIncompleteOwnPin) continue
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      resolve(file) !== file ||
      !relative(root, file).startsWith(PLUGIN_PINS_DIR)
    )
      throw new Error('unsafe plugin pin path')
    let parsed
    try {
      parsed = parsePluginPin(JSON.parse(await readBoundedRegularText(file, 'plugin pin')))
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

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export async function assertCheckoutIdentity(
  root: string,
  commit: string,
  originUrl: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid pinned commit')
  const git = createGitReader(root, signal)
  const head = (await git.read(['rev-parse', '--verify', 'HEAD'])).toString('ascii').trim()
  const origin = (await git.read(['config', '--local', '--get-all', 'remote.origin.url']))
    .toString('utf8')
    .trim()
  if (head !== commit || origin !== originUrl || origin.includes('\n'))
    throw new Error('checkout identity differs from pin')
}

export async function assertManifestPinned(
  root: string,
  commit: string,
  sourcePath: string,
  manifest: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit) || (sourcePath && !cleanPath(sourcePath)))
    throw new Error('invalid pinned release identity')
  const git = createGitReader(root, signal)
  const entries = await authenticatedTree(root, commit, signal)
  const path = [sourcePath, 'holi-plugin.json'].filter(Boolean).join('/')
  const entry = entries.get(path)
  if (!entry || entry.mode !== '100644') throw new Error('manifest absent from pinned Git object')
  const bytes = await makeAuthenticatedBlobReader(git)(entry)
  let raw: unknown
  try {
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid UTF-8')
    raw = JSON.parse(text)
  } catch {
    throw new Error('pinned manifest is invalid JSON')
  }
  const pinned = parsePluginManifest(raw, sourcePath)
  const supplied = parsePluginManifest(manifest, sourcePath)
  if (!pinned.ok || !supplied.ok || canonicalJson(pinned.value) !== canonicalJson(supplied.value))
    throw new Error('manifest differs from pinned Git object')
}

/** Authenticate the release checkout and return exact Git-backed guide snapshots. */
export async function prepareAuthenticatedRelease(input: {
  root: string
  commit: string
  sourcePath: string
  originUrl: string
  manifest: unknown
  skills: readonly string[]
  signal?: AbortSignal
}): Promise<SkillSnapshot[]> {
  await assertCheckoutIdentity(input.root, input.commit, input.originUrl, input.signal)
  await assertManifestPinned(
    input.root,
    input.commit,
    input.sourcePath,
    input.manifest,
    input.signal,
  )
  return readPinnedSkillSnapshots(
    input.root,
    input.commit,
    input.sourcePath,
    input.skills,
    input.signal,
  )
}
