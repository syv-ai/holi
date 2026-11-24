import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isSecretPath, vaultRelPath } from '@holi/shared'

const exec = promisify(execFile)
const MAX_BYTES = 1024 * 1024
const TIMEOUT = 5000

type Entry = { kind: 'text'; text: string } | { kind: 'missing' | 'unsupported' | 'limit' }
export type RevisionComparison =
  | { kind: 'text'; before: string; after: string }
  | { kind: 'unavailable'; reason: 'missing' | 'unsupported' | 'limit' | 'error' }

/** Compare exact commit snapshots using bounded local Git plumbing; never resolve refs or fetch. */
export async function compareRevisions(
  root: string,
  path: string,
  before: string,
  after: string,
): Promise<RevisionComparison> {
  let normalized: string
  try {
    normalized = vaultRelPath(path)
  } catch {
    return { kind: 'unavailable', reason: 'unsupported' }
  }
  if (normalized !== path || isSecretPath(normalized))
    return { kind: 'unavailable', reason: 'unsupported' }
  if (![before, after].every((oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)))
    return { kind: 'unavailable', reason: 'missing' }
  try {
    const values = await Promise.all([before, after].map((oid) => readEntry(root, normalized, oid)))
    if (values.some((value) => value.kind === 'missing'))
      return { kind: 'unavailable', reason: 'missing' }
    if (values.some((value) => value.kind === 'unsupported'))
      return { kind: 'unavailable', reason: 'unsupported' }
    if (values.some((value) => value.kind === 'limit'))
      return { kind: 'unavailable', reason: 'limit' }
    return {
      kind: 'text',
      before: (values[0] as Extract<Entry, { kind: 'text' }>).text,
      after: (values[1] as Extract<Entry, { kind: 'text' }>).text,
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      (error as NodeJS.ErrnoException).killed
    )
      return { kind: 'unavailable', reason: 'limit' }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'unavailable', reason: 'error' }
    return { kind: 'unavailable', reason: 'error' }
  }
}

async function git(root: string, args: string[], maxBuffer = 64 * 1024) {
  return exec('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer,
    timeout: TIMEOUT,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  })
}

async function readEntry(root: string, path: string, commit: string): Promise<Entry> {
  let resolved: Buffer
  try {
    resolved = (
      await git(root, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], 1024)
    ).stdout
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      (error as NodeJS.ErrnoException).killed
    )
      return { kind: 'limit' }
    if (
      (error as NodeJS.ErrnoException).code &&
      (error as { code?: string }).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    )
      return { kind: 'missing' }
    throw error
  }
  if (resolved.toString('ascii').trim().toLowerCase() !== commit.toLowerCase())
    return { kind: 'missing' }
  let stdout: Buffer
  try {
    stdout = (
      await git(
        root,
        ['ls-tree', '-z', '--full-tree', commit, '--', `:(literal)${path}`],
        64 * 1024,
      )
    ).stdout
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      (error as NodeJS.ErrnoException).killed
    )
      return { kind: 'limit' }
    if ((error as { code?: string }).code) return { kind: 'missing' }
    throw error
  }
  if (!stdout.length) return { kind: 'missing' }
  const record = stdout.toString('utf8').replace(/\0$/, '')
  const tab = record.indexOf('\t')
  if (tab < 0 || record.slice(tab + 1) !== path) return { kind: 'missing' }
  const [mode, type, oid] = record.slice(0, tab).split(' ')
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return { kind: 'unsupported' }
  let blob: Buffer
  try {
    blob = (await git(root, ['cat-file', 'blob', oid], MAX_BYTES + 1)).stdout
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      (error as NodeJS.ErrnoException).killed
    )
      return { kind: 'limit' }
    if ((error as { code?: string }).code) return { kind: 'missing' }
    throw error
  }
  if (blob.length > MAX_BYTES) return { kind: 'limit' }
  if (blob.includes(0)) return { kind: 'unsupported' }
  const text = new TextDecoder('utf-8', { fatal: true })
  try {
    return { kind: 'text', text: text.decode(blob) }
  } catch {
    return { kind: 'unsupported' }
  }
}
