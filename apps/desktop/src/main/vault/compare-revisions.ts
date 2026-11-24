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

/** Compare immutable snapshots without consulting refs, fetching, or recording seen state. */
export async function compareRevisions(
  root: string,
  path: string,
  before: string,
  after: string,
): Promise<RevisionComparison> {
  try {
    if (vaultRelPath(path) !== path || isSecretPath(path))
      return { kind: 'unavailable', reason: 'unsupported' }
  } catch {
    return { kind: 'unavailable', reason: 'unsupported' }
  }
  if (![before, after].every((oid) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)))
    return { kind: 'unavailable', reason: 'unsupported' }
  try {
    const left = await readEntry(root, path, before.toLowerCase())
    if (left.kind !== 'text') return { kind: 'unavailable', reason: left.kind }
    const right = await readEntry(root, path, after.toLowerCase())
    if (right.kind !== 'text') return { kind: 'unavailable', reason: right.kind }
    return { kind: 'text', before: left.text, after: right.text }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean }
    return {
      kind: 'unavailable',
      reason:
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.killed ? 'limit' : 'error',
    }
  }
}

async function git(root: string, args: string[], maxBuffer = 64 * 1024, input = '') {
  const pending = exec('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer,
    timeout: TIMEOUT,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  })
  pending.child.stdin?.end(input)
  return pending
}

async function readEntry(root: string, path: string, commit: string): Promise<Entry> {
  // Batch plumbing distinguishes unavailable objects from command failures without parsing stderr.
  const object = (
    await git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], 1024, `${commit}\n`)
  ).stdout
    .toString('ascii')
    .trim()
  if (object === `${commit} missing`) return { kind: 'missing' }
  if (object !== `${commit} commit`) return { kind: 'unsupported' }
  const { stdout } = await git(root, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${path}`,
  ])
  if (!stdout.length) return { kind: 'missing' }
  const record = stdout.toString('utf8').replace(/\0$/, '')
  const tab = record.indexOf('\t')
  if (tab < 0 || record.slice(tab + 1) !== path) return { kind: 'unsupported' }
  const [mode, type, oid] = record.slice(0, tab).split(' ')
  if (!oid || type !== 'blob' || (mode !== '100644' && mode !== '100755'))
    return { kind: 'unsupported' }
  const objectInfo = (
    await git(
      root,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      1024,
      `${oid}\n`,
    )
  ).stdout
    .toString('ascii')
    .trim()
  if (objectInfo === `${oid} missing`) return { kind: 'missing' }
  const [blobOid, blobType, size] = objectInfo.split(' ')
  if (blobOid !== oid || blobType !== 'blob' || size === undefined || !/^\d+$/.test(size))
    return { kind: 'unsupported' }
  if (Number(size) > MAX_BYTES) return { kind: 'limit' }
  const blob = (await git(root, ['cat-file', 'blob', oid], MAX_BYTES + 1)).stdout
  if (blob.length > MAX_BYTES) return { kind: 'limit' }
  if (blob.includes(0)) return { kind: 'unsupported' }
  try {
    return {
      kind: 'text',
      text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob),
    }
  } catch {
    return { kind: 'unsupported' }
  }
}
