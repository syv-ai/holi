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
  if (!report || Object.keys(report).some((key) => !fields.includes(key)))
    throw new Error('Unexpected credential report data')
  const outcomes = {
    'verify-empty': ['empty'],
    store: ['stored'],
    replace: ['replaced'],
    read: ['persisted'],
    'sign-out': ['signed-out'],
    'verify-absent': ['primary-absent'],
    'delete-unrelated': ['empty'],
  }
  if (!report || report.schemaVersion !== 1 || report.source !== 'diagnostic-keychain-namespace')
    throw new Error('Invalid credential report provenance')
  if (report.runId !== runId || report.phase !== phase || !outcomes[phase])
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
  if (
    report.build !== build ||
    !outcomes[phase].includes(report.outcome) ||
    report.tokenRecorded !== false
  )
    throw new Error('Credential report outcome does not match the expected build or phase')
  if (
    ['store', 'replace', 'read'].includes(phase) &&
    (report.metadata?.accessible !== true || report.metadata?.synchronizable !== false)
  )
    throw new Error('Credential metadata is invalid')
  if (['sign-out', 'verify-absent'].includes(phase) && report.unrelatedPreserved !== true)
    throw new Error('Unrelated credential was not preserved')
  return report
}
