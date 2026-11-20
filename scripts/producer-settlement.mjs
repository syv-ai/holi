import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { join } from 'node:path'

const maxReceiptBytes = 4096
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

export function privateDirectory(path) {
  const stat = lstatSync(path)
  if (
    realpathSync(path) !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('Not a private directory')
}

export function readPrivate(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Not a private regular file')
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > limit) throw new Error('Private producer file exceeded bound')
    return bytes.subarray(0, size)
  } finally {
    closeSync(fd)
  }
}

function readReceipt(path) {
  const text = readPrivate(path, maxReceiptBytes).toString('utf8')
  const record = JSON.parse(text)
  // The writer uses compact JSON. Reject duplicate members and noncanonical framing.
  if (JSON.stringify(record) !== text) throw new Error('Invalid private receipt framing')
  return record
}

// The outer ChildProcess receipt covers its own non-detached descendants, not
// these leases. Join the private worker claim, pre-launch admissions, and final
// receipt; never re-probe PIDs that the worker already proved absent.
export function readFinalSettlement(root, identity, leaseRoles, binding = {}) {
  const admissions = join(root, 'admissions')
  const ownership = join(root, 'ownership')
  for (const path of [root, join(root, 'worker-tmp'), admissions, ownership]) privateDirectory(path)
  if (lstatSync(join(root, 'settlement.tmp'), { throwIfNoEntry: false })) return false
  const worker = readReceipt(join(root, 'worker.json'))
  const receipt = readReceipt(join(root, 'settlement.json'))
  const bindingKeys = Object.keys(binding)
  const identityKeys = ['version', 'runId', 'nonce', 'workerPid']
  if (
    !exactKeys(worker, identityKeys) ||
    !exactKeys(receipt, [...identityKeys, 'state', 'admission', 'leases', ...bindingKeys]) ||
    worker.version !== 1 ||
    worker.runId !== identity.runId ||
    worker.nonce !== identity.nonce ||
    !Number.isSafeInteger(worker.workerPid) ||
    worker.workerPid <= 1 ||
    worker.workerPid > 0x7fffffff ||
    !identityKeys.every((key) => receipt[key] === worker[key]) ||
    receipt.state !== 'final' ||
    !bindingKeys.every((key) => receipt[key] === binding[key]) ||
    !Array.isArray(receipt.leases) ||
    receipt.leases.length > leaseRoles.length
  )
    return false

  const seen = new Set()
  const expectedAdmissions = []
  for (const [index, lease] of receipt.leases.entries()) {
    if (
      !exactKeys(lease, ['id', 'role', 'proof']) ||
      typeof lease.id !== 'string' ||
      !uuid.test(lease.id) ||
      seen.has(lease.id) ||
      lease.role !== leaseRoles[index] ||
      !['settled', 'kernel-absence'].includes(lease.proof)
    )
      return false
    seen.add(lease.id)
    expectedAdmissions.push(`${lease.role}-${lease.id}`)
    privateDirectory(join(ownership, lease.id))
    privateDirectory(join(admissions, expectedAdmissions[index]))
  }
  const sameEntries = (path, expected) => {
    const entries = readdirSync(path)
    return entries.length === expected.length && expected.every((name) => entries.includes(name))
  }
  if (!sameEntries(admissions, expectedAdmissions) || !sameEntries(ownership, [...seen]))
    return false
  if (receipt.admission !== (seen.size ? 'leases-settled' : 'no-admission')) return false
  return receipt
}
