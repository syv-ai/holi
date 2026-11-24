import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MAX_BYTES = 1024 * 1024
const TIMEOUT = 5000

export type RevisionComparison =
  | { kind: 'text'; before: string; after: string }
  | { kind: 'unavailable'; reason: 'missing' | 'unsupported' | 'limit' }

/** Compare exact commit snapshots using local Git plumbing; never resolve refs or fetch. */
export async function compareRevisions(
  root: string,
  path: string,
  before: string,
  after: string,
): Promise<RevisionComparison> {
  if (![before, after].every((oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)))
    throw new TypeError('Invalid commit object id')
  try {
    const values = await Promise.all([before, after].map((oid) => readEntry(root, path, oid)))
    if (values.some((value) => value === null)) return { kind: 'unavailable', reason: 'missing' }
    if (values.some((value) => value === 'unsupported'))
      return { kind: 'unavailable', reason: 'unsupported' }
    return { kind: 'text', before: values[0] as string, after: values[1] as string }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      (error as NodeJS.ErrnoException).killed
    )
      return { kind: 'unavailable', reason: 'limit' }
    return { kind: 'unavailable', reason: 'missing' }
  }
}

async function git(root: string, args: string[], maxBuffer = 64 * 1024) {
  return exec('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer, timeout: TIMEOUT })
}

async function readEntry(
  root: string,
  path: string,
  commit: string,
): Promise<string | null | 'unsupported'> {
  const { stdout: resolved } = await git(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`],
    1024,
  )
  if (resolved.toString().trim().toLowerCase() !== commit.toLowerCase()) return null
  const { stdout } = await git(
    root,
    ['ls-tree', '-z', '--full-tree', commit, '--', path],
    64 * 1024,
  )
  if (stdout.length === 0) return null
  const record = stdout.toString('utf8').replace(/\0$/, '')
  const tab = record.indexOf('\t')
  if (tab < 0 || record.slice(tab + 1) !== path) return null
  const [mode, type, oid] = record.slice(0, tab).split(' ')
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return 'unsupported'
  const blob = (await git(root, ['cat-file', 'blob', oid], MAX_BYTES + 1)).stdout
  if (blob.length > MAX_BYTES || blob.includes(0)) return 'unsupported'
  return blob.toString('utf8')
}
