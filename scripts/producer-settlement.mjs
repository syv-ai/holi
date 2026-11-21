import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const maxReceiptBytes = 4096
const maxNativeRecordBytes = 1024
const identityKeys = ['version', 'runId', 'nonce', 'workerPid']
const leaseKeys = ['id', 'role']
const privateFile = { mode: 0o600, flag: 'wx' }
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

function parseReceipt(bytes) {
  const record = JSON.parse(bytes)
  // Reject duplicate members, invalid UTF-8, and noncanonical framing.
  if (!bytes.equals(Buffer.from(JSON.stringify(record))))
    throw new Error('Invalid private receipt framing')
  return record
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exists = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined
const sameEntries = (path, expected) => {
  const entries = readdirSync(path)
  return entries.length === expected.length && expected.every((name) => entries.includes(name))
}
const matches = (record, reference, keys) => keys.every((key) => record[key] === reference[key])

// The on-disk HOLI-POSIX-1 format lives in posix-ownership-journal.ts and
// posix-lease.c. A native SETTLED may cover a valid journal prefix (startup
// cancelled before GO); a cold kernel-absence proof requires COMPLETE.
function journalIdentities(journal, id) {
  const header = `HOLI-POSIX-1 ${id}\n`
  if (typeof journal !== 'string' || !journal.startsWith(header) || !journal.endsWith('\n'))
    throw new Error('Invalid native ownership journal framing or identity')
  const lines = journal.slice(header.length).split('\n')
  lines.pop()
  const pids = []
  for (const [index, line] of lines.entries()) {
    if (index === 3 && line === 'COMPLETE' && lines.length === 4) {
      const [root, reaper, anchor] = pids
      return [reaper, -reaper, anchor, root, -root]
    }
    const row = /^(ROOT|REAPER|ANCHOR) ([1-9]\d{0,9})$/.exec(line)
    const pid = Number(row?.[2])
    if (
      !row ||
      row[1] !== ['ROOT', 'REAPER', 'ANCHOR'][index] ||
      pid <= 1 ||
      pid > 0x7fffffff ||
      pids.includes(pid)
    )
      throw new Error('Invalid, partial, or failed native ownership journal')
    pids.push(pid)
  }
  return null
}

function readNativeRecords(path) {
  privateDirectory(path)
  const settled = exists(join(path, 'settled'))
  if (!sameEntries(path, settled ? ['journal', 'settled'] : ['journal']))
    throw new Error('Unexpected, partial, or failed native ownership record')
  const read = (name) => {
    const bytes = readPrivate(join(path, name), maxNativeRecordBytes)
    const text = bytes.toString('utf8')
    if (!bytes.equals(Buffer.from(text))) throw new Error('Invalid native ownership encoding')
    return text
  }
  return { journal: read('journal'), ...(settled && { settled: read('settled') }) }
}

// Called only by the worker after joining the lease. Save the complete native
// records under its pre-launch admission before the parent can retire the root.
// Only a missing terminal marker needs the native cold inspector, which checks
// every PID/group for ESRCH and rechecks for any final journal writes.
export function cacheLeaseProof(root, identity, { id, role }, inspectOwnership) {
  const path = join(root, 'ownership', id)
  const admission = join(root, 'admissions', `${role}-${id}`)
  privateDirectory(admission)
  const records = readNativeRecords(path)
  const ids = journalIdentities(records.journal, id)
  let proof = 'settled'
  let snapshot = records
  if (records.settled === undefined) {
    const inspection = inspectOwnership(path)
    if (
      !ids ||
      inspection.state !== 'confirmed' ||
      inspection.proof !== 'kernel-absence' ||
      !matches(readNativeRecords(path), records, ['journal', 'settled'])
    )
      throw new Error('Native ownership absence was not confirmed for this journal')
    proof = 'kernel-absence'
    snapshot = { ...records, absenceSnapshot: { protocol: 'posix-kill-0', absent: ids } }
  } else if (records.settled !== `HOLI-POSIX-1 ${id}\nSETTLED\n`) {
    throw new Error('Invalid native ownership settlement')
  }
  const bytes = JSON.stringify({ ...identity, id, role, ...snapshot })
  writeFileSync(join(admission, 'proof.json'), bytes, privateFile)
  return { id, role, proof, proofSha256: sha256(bytes) }
}

function verifyLeaseProof(ownership, admission, worker, lease, requireComplete) {
  privateDirectory(admission)
  if (!sameEntries(admission, ['proof.json'])) return false
  const bytes = readPrivate(join(admission, 'proof.json'), maxReceiptBytes)
  if (sha256(bytes) !== lease.proofSha256) return false
  const cache = parseReceipt(bytes)
  const native = readNativeRecords(ownership)
  const settled = lease.proof === 'settled'
  if (
    !exactKeys(cache, [
      ...identityKeys,
      ...leaseKeys,
      'journal',
      settled ? 'settled' : 'absenceSnapshot',
    ]) ||
    !matches(cache, worker, identityKeys) ||
    !matches(cache, lease, leaseKeys) ||
    !matches(cache, native, ['journal', 'settled'])
  )
    return false
  const ids = journalIdentities(cache.journal, lease.id)
  if (settled)
    return (
      (!requireComplete || ids !== null) && cache.settled === `HOLI-POSIX-1 ${lease.id}\nSETTLED\n`
    )
  const snapshot = cache.absenceSnapshot
  return (
    ids !== null &&
    exactKeys(snapshot, ['protocol', 'absent']) &&
    snapshot.protocol === 'posix-kill-0' &&
    Array.isArray(snapshot.absent) &&
    snapshot.absent.length === ids.length &&
    ids.every((id, index) => snapshot.absent[index] === id)
  )
}

export async function publishFinalSettlement(root, identity, leases, evidenceName, bytes) {
  const evidenceStage = join(root, `${evidenceName}.tmp`)
  await writeFile(evidenceStage, bytes, privateFile)
  await rename(evidenceStage, join(root, evidenceName))
  const staging = join(root, 'settlement.tmp')
  await writeFile(
    staging,
    JSON.stringify({
      ...identity,
      state: 'final',
      admission: leases.length ? 'leases-settled' : 'no-admission',
      leases,
      evidenceSha256: sha256(bytes),
    }),
    privateFile,
  )
  await rename(staging, join(root, 'settlement.json'))
}

// The outer ChildProcess receipt covers its own non-detached descendants, not
// these leases. Join the private worker claim, pre-launch admissions, native
// snapshots and the exact evidence bytes already read by the parent. No probes.
export function readFinalSettlement(root, identity, leaseRoles, evidenceBytes, requireComplete) {
  const admissions = join(root, 'admissions')
  const ownership = join(root, 'ownership')
  for (const path of [root, join(root, 'worker-tmp'), admissions, ownership]) privateDirectory(path)
  if (exists(join(root, 'settlement.tmp'))) return false
  const worker = parseReceipt(readPrivate(join(root, 'worker.json'), maxReceiptBytes))
  const receipt = parseReceipt(readPrivate(join(root, 'settlement.json'), maxReceiptBytes))
  if (
    !exactKeys(worker, identityKeys) ||
    !exactKeys(receipt, [...identityKeys, 'state', 'admission', 'leases', 'evidenceSha256']) ||
    worker.version !== 1 ||
    worker.runId !== identity.runId ||
    worker.nonce !== identity.nonce ||
    !Number.isSafeInteger(worker.workerPid) ||
    worker.workerPid <= 1 ||
    worker.workerPid > 0x7fffffff ||
    !matches(receipt, worker, identityKeys) ||
    receipt.state !== 'final' ||
    receipt.evidenceSha256 !== sha256(evidenceBytes) ||
    !Array.isArray(receipt.leases) ||
    receipt.leases.length > leaseRoles.length
  )
    return false

  const seen = new Set()
  const expectedAdmissions = []
  for (const [index, lease] of receipt.leases.entries()) {
    if (
      !exactKeys(lease, [...leaseKeys, 'proof', 'proofSha256']) ||
      typeof lease.id !== 'string' ||
      !uuid.test(lease.id) ||
      seen.has(lease.id) ||
      lease.role !== leaseRoles[index] ||
      !['settled', 'kernel-absence'].includes(lease.proof)
    )
      return false
    seen.add(lease.id)
    expectedAdmissions.push(`${lease.role}-${lease.id}`)
    if (
      !verifyLeaseProof(
        join(ownership, lease.id),
        join(admissions, expectedAdmissions[index]),
        worker,
        lease,
        requireComplete,
      )
    )
      return false
  }
  if (!sameEntries(admissions, expectedAdmissions) || !sameEntries(ownership, [...seen]))
    return false
  if (receipt.admission !== (seen.size ? 'leases-settled' : 'no-admission')) return false
  return receipt
}
