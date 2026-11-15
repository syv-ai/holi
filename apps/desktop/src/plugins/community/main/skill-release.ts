import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_PINS_DIR, parsePluginPin } from '@holi/shared'
import type { SkillSnapshot } from './skill-transaction'

function git(root: string, args: string[]): Buffer {
  return execFileSync(
    'git',
    [
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    },
  )
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
function tree(root: string, commit: string): Map<string, TreeEntry> {
  const raw = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit])
  const entries = new Map<string, TreeEntry>()
  for (const item of raw.toString('utf8').split('\0')) {
    if (!item) continue
    const tab = item.indexOf('\t')
    const [mode, type, oid] = item.slice(0, tab).split(' ')
    const path = item.slice(tab + 1)
    if (!mode || !type || !oid || path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('invalid release tree entry')
    entries.set(path, { mode, type, oid, path })
  }
  return entries
}

function blob(root: string, entry: TreeEntry): Buffer {
  return git(root, ['cat-file', 'blob', entry.oid])
}

function cleanPath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  )
}

function resolveTreeFile(
  root: string,
  entries: Map<string, TreeEntry>,
  path: string,
  allowedRoot: string,
  seen = new Set<string>(),
): { bytes: Buffer; mode: number; dirs: string[] } {
  if (!cleanPath(path) || seen.has(path)) throw new Error('invalid or cyclic skill symlink')
  const entry = entries.get(path)
  if (!entry || entry.type !== 'blob')
    throw new Error(`skill file absent from pinned tree: ${path}`)
  if (entry.mode === '120000') {
    const linkBytes = blob(root, entry)
    if (objectId(linkBytes) !== entry.oid) throw new Error('invalid symlink Git object')
    const target = linkBytes.toString('utf8')
    if (isAbsolute(target) || target.includes('\\')) throw new Error('unsafe skill symlink')
    const next = resolve('/', path.slice(0, path.lastIndexOf('/')), target).slice(1)
    if (
      !cleanPath(next) ||
      (allowedRoot !== '' && next !== allowedRoot && !next.startsWith(`${allowedRoot}/`))
    )
      throw new Error('skill symlink escapes plugin')
    return resolveTreeFile(root, entries, next, allowedRoot, new Set(seen).add(path))
  }
  if (entry.mode !== '100644' && entry.mode !== '100755')
    throw new Error('special skill file in release')
  const dirs: string[] = []
  let parent = path.slice(0, path.lastIndexOf('/'))
  while (parent) {
    dirs.push(parent)
    parent = parent.slice(0, parent.lastIndexOf('/'))
  }
  const bytes = blob(root, entry)
  if (objectId(bytes) !== entry.oid) throw new Error('invalid file Git object')
  return { bytes, mode: entry.mode === '100755' ? 0o755 : 0o644, dirs }
}

/** Prove the private publication snapshot against immutable commit objects. */
export function validateSkillSnapshot(
  root: string,
  commit: string,
  sourcePath: string,
  skills: readonly string[],
  snapshots: readonly SkillSnapshot[],
): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid pinned commit')
  const entries = tree(root, commit)
  const expectedNames = new Set(skills.map((item) => item.split('/').at(-1)))
  if (snapshots.some((snapshot) => !expectedNames.has(snapshot.name)))
    throw new Error('undeclared skill snapshot')
  for (const snapshot of snapshots) {
    const skill = skills.find((item) => item.split('/').at(-1) === snapshot.name)!
    const prefix = [sourcePath, skill].filter(Boolean).join('/')
    const expectedFiles = new Map<string, { bytes: Buffer; mode: number }>()
    const expectedDirs = new Set<string>()
    for (const path of entries.keys()) {
      if (!path.startsWith(`${prefix}/`)) continue
      const rel = path.slice(prefix.length + 1)
      const resolved = resolveTreeFile(root, entries, path, sourcePath)
      expectedFiles.set(rel, { bytes: resolved.bytes, mode: resolved.mode })
      for (const dir of resolved.dirs) {
        if (dir.startsWith(`${prefix}/`)) expectedDirs.add(dir.slice(prefix.length + 1))
      }
    }
    if (!expectedFiles.has('SKILL.md'))
      throw new Error(`required skill is absent from pin: ${snapshot.name}`)
    if (
      expectedFiles.size !== snapshot.files.length ||
      expectedDirs.size !== snapshot.directories.length
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

export function assertManifestPinned(
  root: string,
  commit: string,
  sourcePath: string,
  manifest: unknown,
): void {
  const entries = tree(root, commit)
  const path = [sourcePath, 'holi-plugin.json'].filter(Boolean).join('/')
  const entry = entries.get(path)
  if (!entry || entry.mode !== '100644') throw new Error('manifest absent from pinned Git object')
  const bytes = blob(root, entry)
  if (
    objectId(bytes) !== entry.oid ||
    JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(manifest)
  )
    throw new Error('manifest differs from pinned Git object')
}
