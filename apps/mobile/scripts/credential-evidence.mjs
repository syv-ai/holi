import { setTimeout as sleep } from 'node:timers/promises'
import { readBoundedJson } from './storage-evidence.mjs'

const outcomes = new Map([
  ['verify-empty', 'empty'],
  ['store', 'stored'],
  ['replace', 'replaced'],
  ['read', 'persisted'],
  ['sign-out', 'signed-out'],
  ['verify-absent', 'primary-absent'],
  ['delete-unrelated', 'empty'],
])
const metadataPhases = ['store', 'replace', 'read']
const isolationPhases = ['sign-out', 'verify-absent']

export function validateCredentialReport(report, { runId, phase, build, pid, launchedAt, now }) {
  const fields = [
    'schemaVersion',
    'source',
    'runId',
    'phase',
    'build',
    'pid',
    'observedAt',
    'outcome',
    'tokenRecorded',
    'metadata',
    'unrelatedPreserved',
  ]
  if (!report || report.schemaVersion !== 1 || report.source !== 'diagnostic-keychain-namespace')
    throw new Error('Invalid credential report provenance')
  if (
    typeof runId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId) ||
    report.runId !== runId ||
    report.phase !== phase ||
    !outcomes.has(phase)
  )
    throw new Error('Credential report does not match the active run and phase')
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    report.pid !== pid ||
    !Number.isSafeInteger(report.observedAt) ||
    report.observedAt < launchedAt ||
    report.observedAt > now
  )
    throw new Error('Credential report does not belong to the active process')
  if (report.outcome === 'failed') throw new Error('Native credential phase reported failure')
  if (Object.keys(report).some((key) => !fields.includes(key)))
    throw new Error('Unexpected credential report data')
  if (
    typeof build !== 'string' ||
    !/^\d{1,10}(?:\.\d{1,10}){0,2}$/.test(build) ||
    report.build !== build ||
    report.outcome !== outcomes.get(phase) ||
    report.tokenRecorded !== false
  )
    throw new Error('Credential report outcome does not match the expected build or phase')
  if (
    metadataPhases.includes(phase) &&
    (report.metadata?.accessible !== true || report.metadata?.synchronizable !== false)
  )
    throw new Error('Credential metadata is invalid')
  if (isolationPhases.includes(phase) && report.unrelatedPreserved !== true)
    throw new Error('Unrelated credential was not preserved')
  return {
    schemaVersion: 1,
    source: 'diagnostic-keychain-namespace',
    runId,
    phase,
    build,
    pid,
    observedAt: report.observedAt,
    outcome: outcomes.get(phase),
    tokenRecorded: false,
    ...(metadataPhases.includes(phase)
      ? { metadata: { accessible: true, synchronizable: false } }
      : {}),
    ...(isolationPhases.includes(phase) ? { unrelatedPreserved: true } : {}),
  }
}

export function summarizeCredentialReport(report) {
  const phase = outcomes.has(report?.phase) ? report.phase : 'unexpected'
  return {
    schemaVersion: report?.schemaVersion === 1 ? 1 : null,
    phase,
    outcome:
      report?.outcome === 'failed' ||
      (outcomes.has(phase) && report.outcome === outcomes.get(phase))
        ? report.outcome
        : 'unexpected',
    pid: Number.isSafeInteger(report?.pid) && report.pid > 0 ? report.pid : null,
    observedAt: Number.isSafeInteger(report?.observedAt) ? report.observedAt : null,
    ...(metadataPhases.includes(phase)
      ? {
          metadata: {
            accessible: report?.metadata?.accessible === true,
            synchronizable: report?.metadata?.synchronizable !== false,
          },
        }
      : {}),
    ...(isolationPhases.includes(phase)
      ? { unrelatedPreserved: report?.unrelatedPreserved === true }
      : {}),
    tokenRecorded: report?.tokenRecorded !== false,
    nativeErrorReported: Boolean(report?.error),
    nativeError:
      report?.error?.kind === 'keychain' &&
      ['read', 'write', 'remove', 'metadata'].includes(report.error.operation) &&
      Number.isInteger(report.error.status) &&
      report.error.status >= -2147483648 &&
      report.error.status <= 2147483647
        ? { kind: 'keychain', operation: report.error.operation, status: report.error.status }
        : report?.error?.kind === 'interop'
          ? {
              kind: 'interop',
              selector: ['read', 'writeError', 'remove', 'metadata'].includes(report.error.selector)
                ? report.error.selector
                : 'unknown',
            }
          : undefined,
  }
}

export async function waitForCredentialReport(path, { signal, timeout = 90_000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Credential observation interrupted')
    try {
      return await readBoundedJson(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await sleep(150, undefined, { signal })
  }
  throw Object.assign(new Error('Credential observation deadline'), { timedOut: true })
}
