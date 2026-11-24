import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isSecretPath, vaultRelPath } from '@holi/shared'

const exec = promisify(execFile)
const MAX_BYTES = 1024 * 1024
const TIMEOUT = 5000
class ReadLimit extends Error {}

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
    const deadline = Date.now() + TIMEOUT
    const left = await readEntry(root, path, before.toLowerCase(), deadline)
    if (left.kind !== 'text') return { kind: 'unavailable', reason: left.kind }
    const right = await readEntry(root, path, after.toLowerCase(), deadline)
    if (right.kind !== 'text') return { kind: 'unavailable', reason: right.kind }
    return { kind: 'text', before: left.text, after: right.text }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean }
    return {
      kind: 'unavailable',
      reason:
        error instanceof ReadLimit ||
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.killed
          ? 'limit'
          : 'error',
    }
  }
}

async function git(
  root: string,
  args: string[],
  deadline: number,
  maxBuffer = 64 * 1024,
  input = '',
) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ReadLimit()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  const pending = exec('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer,
    timeout: remaining,
    killSignal: 'SIGKILL',
    env: { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
  })
  // Git may exit before consuming batch input; the process result remains authoritative.
  pending.child.stdin?.on('error', () => {})
  pending.child.stdin?.end(input)
  return pending
}

async function readEntry(
  root: string,
  path: string,
  commit: string,
  deadline: number,
): Promise<Entry> {
  const object = (
    await git(
      root,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      deadline,
      1024,
      `${commit}\n`,
    )
  ).stdout
    .toString('ascii')
    .trim()
  if (object === `${commit} missing`) return { kind: 'missing' }
  if (object !== `${commit} commit`) return { kind: 'unsupported' }
  const rawCommit = (await git(root, ['cat-file', 'commit', commit], deadline)).stdout
  const tree = /^tree ([0-9a-f]{40}|[0-9a-f]{64})\n/.exec(rawCommit.toString('utf8'))?.[1]
  if (!tree) return { kind: 'unsupported' }
  let treeOid = tree
  let blobOid: string | undefined
  const segments = path.split('/')
  for (let index = 0; index < segments.length; index++) {
    // Check each traversed tree explicitly: missing history is not an empty file or a command error.
    const treeInfo = (
      await git(
        root,
        ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
        deadline,
        1024,
        `${treeOid}\n`,
      )
    ).stdout
      .toString('ascii')
      .trim()
    if (treeInfo === `${treeOid} missing`) return { kind: 'missing' }
    if (treeInfo !== `${treeOid} tree`) return { kind: 'unsupported' }
    const segment = segments[index]!
    const { stdout } = await git(
      root,
      ['ls-tree', '-z', treeOid, '--', `:(literal)${segment}`],
      deadline,
    )
    if (!stdout.length) return { kind: 'missing' }
    const record = stdout.toString('utf8').replace(/\0$/, '')
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== segment) return { kind: 'unsupported' }
    const [mode, type, oid] = record.slice(0, tab).split(' ')
    if (!oid) return { kind: 'unsupported' }
    if (index < segments.length - 1) {
      if (type !== 'tree' || mode !== '040000') return { kind: 'unsupported' }
      treeOid = oid
    } else {
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755'))
        return { kind: 'unsupported' }
      blobOid = oid
    }
  }
  if (!blobOid) return { kind: 'unsupported' }
  const objectInfo = (
    await git(
      root,
      ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      deadline,
      1024,
      `${blobOid}\n`,
    )
  ).stdout
    .toString('ascii')
    .trim()
  if (objectInfo === `${blobOid} missing`) return { kind: 'missing' }
  const [oid, type, size] = objectInfo.split(' ')
  if (oid !== blobOid || type !== 'blob' || size === undefined || !/^\d+$/.test(size))
    return { kind: 'unsupported' }
  if (Number(size) > MAX_BYTES) return { kind: 'limit' }
  const blob = (await git(root, ['cat-file', 'blob', blobOid], deadline, MAX_BYTES + 1)).stdout
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
