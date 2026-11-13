import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const preparations = new Map<string, Promise<void>>()
type IndexEntry = { mode: string; oid: string; stage: number; path: string }

/** Prepare one managed clone before any seed, scan, watcher or runtime sees it. */
export function prepareManagedClone(root: string): Promise<void> {
  const key = resolve(root)
  const previous = preparations.get(key) ?? Promise.resolve()
  const run = previous.then(() => prepare(key))
  const settled = run.catch(() => {})
  preparations.set(key, settled)
  void settled.then(() => {
    if (preparations.get(key) === settled) preparations.delete(key)
  })
  return run
}

async function git(root: string, args: string[], input?: Buffer): Promise<Buffer> {
  if (input === undefined) {
    const { stdout } = await exec('git', args, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
    })
    return stdout as Buffer
  }
  return new Promise((resolveOutput, reject) => {
    const child = spawn('git', args, { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    // Git may reject the input before the producer finishes writing (for
    // example, a large path list against a malformed repository). Consume EPIPE;
    // the close handler below reports Git's actual failure.
    child.stdin.on('error', () => {})
    child.once('close', (code) => {
      if (code === 0) resolveOutput(Buffer.concat(stdout))
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || `git exited ${code}`))
    })
    child.stdin.end(input)
  })
}

function nulFields(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      fields.push(bytes.subarray(start, i))
      start = i + 1
    }
  }
  if (start !== bytes.length) throw new Error('git returned malformed NUL-delimited output')
  return fields
}

function parseIndex(bytes: Buffer): IndexEntry[] {
  return nulFields(bytes).map((field) => {
    const tab = field.indexOf(9)
    const parts = field.subarray(0, tab).toString('ascii').split(' ')
    if (tab < 0 || parts.length !== 3) throw new Error('git returned malformed index entry')
    return {
      mode: parts[0]!,
      oid: parts[1]!,
      stage: Number(parts[2]),
      path: field.subarray(tab + 1).toString('utf8'),
    }
  })
}

async function rawBlobs(root: string, oids: readonly string[]): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  if (oids.length === 0) return result
  const response = await git(root, ['cat-file', '--batch'], Buffer.from(`${oids.join('\n')}\n`))
  let offset = 0
  for (const oid of oids) {
    const newline = response.indexOf(10, offset)
    if (newline < 0) throw new Error('git returned malformed blob header')
    const [returnedOid, type, sizeText] = response
      .subarray(offset, newline)
      .toString('ascii')
      .split(' ')
    const size = Number(sizeText)
    if (returnedOid !== oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('git returned malformed blob response')
    }
    const start = newline + 1
    const end = start + size
    if (end >= response.length || response[end] !== 10)
      throw new Error('git returned truncated blob')
    result.set(oid, response.subarray(start, end))
    offset = end + 1
  }
  if (offset !== response.length) throw new Error('git returned trailing blob data')
  return result
}

async function prepare(root: string): Promise<void> {
  // A failed local config write is fatal: future Git operations must not convert
  // these files back to CRLF.
  await git(root, ['config', '--local', 'core.autocrlf', 'false'])
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD'])
  } catch (error) {
    // A freshly cloned, empty GitHub repository has an unborn branch. There are
    // no tracked files yet; config is the only preparation it needs.
    await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => {
      throw error
    })
    return
  }
  const [index, staged, unmerged] = await Promise.all([
    git(root, ['ls-files', '--stage', '-z']),
    git(root, ['diff-index', '--cached', '--name-only', '-z', 'HEAD']),
    git(root, ['ls-files', '--unmerged', '-z']),
  ])
  const entries = parseIndex(index)
  const stagedPaths = new Set(nulFields(staged).map((p) => p.toString('utf8')))
  const unmergedPaths = new Set(parseIndex(unmerged).map((entry) => entry.path))
  const stageZero = entries.filter((entry) => entry.stage === 0)
  const paths = stageZero
    .filter(
      (entry) =>
        ['100644', '100755'].includes(entry.mode) &&
        !stagedPaths.has(entry.path) &&
        !unmergedPaths.has(entry.path),
    )
    .map((entry) => entry.path)
  if (paths.length === 0) return
  const candidateSet = new Set(paths)
  const attrOutput = await git(
    root,
    [
      'check-attr',
      '-z',
      '--stdin',
      'text',
      'eol',
      'crlf',
      'filter',
      'working-tree-encoding',
      'ident',
    ],
    Buffer.from(`${paths.join('\0')}\0`),
  )
  const attrs = new Map<string, Map<string, string>>()
  const fields = nulFields(attrOutput)
  if (fields.length % 3 !== 0) throw new Error('git returned malformed attributes')
  for (let i = 0; i < fields.length; i += 3) {
    const path = fields[i]!.toString('utf8')
    let values = attrs.get(path)
    if (!values) attrs.set(path, (values = new Map()))
    values.set(fields[i + 1]!.toString('ascii'), fields[i + 2]!.toString('utf8'))
  }
  const candidates: {
    entry: IndexEntry
    file: string
    worktree: Buffer
    attributes: Map<string, string>
  }[] = []
  for (const entry of stageZero) {
    if (!candidateSet.has(entry.path) || unmergedPaths.has(entry.path)) continue
    const attributes = attrs.get(entry.path)
    if (!attributes || !safeTextAttributes(attributes)) continue
    const file = await safeRegularPath(root, entry.path)
    if (file === null) continue
    const worktree = await readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (worktree === null || !containsCrLf(worktree) || hasNul(worktree)) continue
    candidates.push({ entry, file, worktree, attributes })
  }
  // Only potential text conversions need their index blobs. Asset-heavy vaults
  // must not load every tracked image or PDF into memory on each cold open.
  const blobs = await rawBlobs(root, [...new Set(candidates.map(({ entry }) => entry.oid))])
  for (const { entry, file, worktree, attributes } of candidates) {
    const blob = blobs.get(entry.oid)!
    if (!sameAfterCrlfToLf(worktree, blob) || hasNul(blob)) continue
    await refresh(root, entry, file, blob, worktree, attributes)
  }
}

function containsCrLf(bytes: Buffer): boolean {
  for (let i = 1; i < bytes.length; i++) if (bytes[i - 1] === 13 && bytes[i] === 10) return true
  return false
}

function hasNul(bytes: Buffer): boolean {
  return bytes.includes(0)
}

function sameAfterCrlfToLf(worktree: Buffer, blob: Buffer): boolean {
  let offset = 0
  for (let i = 0; i < worktree.length; i++) {
    if (worktree[i] === 13 && worktree[i + 1] === 10) {
      if (blob[offset++] !== 10) return false
      i++
    } else if (worktree[i] !== blob[offset++]) return false
  }
  return offset === blob.length
}

function safeTextAttributes(values: Map<string, string> | undefined): boolean {
  if (!values) return false
  const text = values.get('text')
  const eol = values.get('eol')
  return (
    (text === 'unspecified' || text === 'set' || text === 'auto') &&
    (eol === 'unspecified' || eol === 'lf') &&
    values.get('crlf') === 'unspecified' &&
    values.get('filter') === 'unspecified' &&
    values.get('working-tree-encoding') === 'unspecified' &&
    values.get('ident') === 'unspecified'
  )
}

async function safeRegularPath(root: string, relative: string): Promise<string | null> {
  if (
    relative.startsWith('/') ||
    relative.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return null
  const target = join(root, ...relative.split('/'))
  const parts = relative.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return null
  }
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info || !info.isFile() || info.isSymbolicLink()) return null
  const canonicalRoot = await realpath(root)
  const canonicalParent = await realpath(dirname(target))
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`))
    return null
  return target
}

async function refresh(
  root: string,
  entry: IndexEntry,
  file: string,
  blob: Buffer,
  original: Buffer,
  attributes: Map<string, string> | undefined,
): Promise<void> {
  // Re-read all mutable evidence immediately before replacement. A new edit,
  // staging operation, conflict or symlink causes this candidate to be skipped.
  const [index, staged, unmerged, currentPath] = await Promise.all([
    git(root, ['ls-files', '--stage', '-z']),
    git(root, ['diff-index', '--cached', '--name-only', '-z', 'HEAD']),
    git(root, ['ls-files', '--unmerged', '-z']),
    safeRegularPath(root, entry.path),
  ])
  if (currentPath !== file || nulFields(staged).some((p) => p.toString('utf8') === entry.path))
    return
  if (parseIndex(index).some((item) => item.path === entry.path && item.stage !== 0)) return
  if (parseIndex(unmerged).some((item) => item.path === entry.path)) return
  const currentEntry = parseIndex(index).find(
    (item) => item.path === entry.path && item.stage === 0,
  )
  if (!currentEntry || currentEntry.mode !== entry.mode || currentEntry.oid !== entry.oid) return
  const current = await readFile(file)
  if (!current.equals(original) || !sameAfterCrlfToLf(current, blob)) return
  const currentAttrs = await git(root, [
    'check-attr',
    '-z',
    'text',
    'eol',
    'crlf',
    'filter',
    'working-tree-encoding',
    'ident',
    '--',
    entry.path,
  ])
  const values = nulFields(currentAttrs)
  const now = new Map<string, string>()
  for (let i = 0; i < values.length; i += 3)
    now.set(values[i + 1]!.toString('ascii'), values[i + 2]!.toString('utf8'))
  if (
    !safeTextAttributes(now) ||
    !attributes ||
    [...attributes].some(([key, value]) => now.get(key) !== value)
  )
    return
  const info = await lstat(file)
  const temporary = join(dirname(file), `.holi-line-ending-${randomBytes(8).toString('hex')}`)
  const handle = await open(temporary, 'wx', info.mode & 0o777)
  try {
    await handle.writeFile(blob)
    await handle.chmod(info.mode & 0o777)
    await handle.close()
    // Revalidate every mutable eligibility condition after writing the temp
    // file. The index and attributes can change while that write is in flight.
    const [index, staged, unmerged, latest] = await Promise.all([
      git(root, ['ls-files', '--stage', '-z']),
      git(root, ['diff-index', '--cached', '--name-only', '-z', 'HEAD']),
      git(root, ['ls-files', '--unmerged', '-z']),
      safeRegularPath(root, entry.path),
    ])
    const entries = parseIndex(index)
    const currentEntry = entries.find((item) => item.path === entry.path && item.stage === 0)
    const latestInfo = latest === file ? await lstat(file) : null
    if (
      latest !== file ||
      latestInfo === null ||
      !latestInfo.isFile() ||
      latestInfo.dev !== info.dev ||
      latestInfo.ino !== info.ino ||
      (latestInfo.mode & 0o777) !== (info.mode & 0o777) ||
      nulFields(staged).some((path) => path.toString('utf8') === entry.path) ||
      entries.some((item) => item.path === entry.path && item.stage !== 0) ||
      parseIndex(unmerged).some((item) => item.path === entry.path) ||
      !currentEntry ||
      currentEntry.mode !== entry.mode ||
      currentEntry.oid !== entry.oid ||
      !(await readFile(file)).equals(original)
    )
      return
    const latestAttrs = await git(root, [
      'check-attr',
      '-z',
      'text',
      'eol',
      'crlf',
      'filter',
      'working-tree-encoding',
      'ident',
      '--',
      entry.path,
    ])
    const latestValues = nulFields(latestAttrs)
    const latestMap = new Map<string, string>()
    for (let i = 0; i < latestValues.length; i += 3)
      latestMap.set(latestValues[i + 1]!.toString('ascii'), latestValues[i + 2]!.toString('utf8'))
    if (
      !safeTextAttributes(latestMap) ||
      !attributes ||
      [...attributes].some(([key, value]) => latestMap.get(key) !== value)
    )
      return
    await rename(temporary, file)
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}
