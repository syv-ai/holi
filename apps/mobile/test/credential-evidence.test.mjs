import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  validateCredentialReport,
  summarizeCredentialReport,
  waitForCredentialReport,
} from '../scripts/credential-evidence.mjs'

const context = {
  runId: 'owned-run',
  phase: 'store',
  build: '1',
  pid: 1234,
  launchedAt: 1000,
  now: 2000,
}
const report = {
  schemaVersion: 1,
  source: 'diagnostic-keychain-namespace',
  runId: 'owned-run',
  phase: 'store',
  build: '1',
  pid: 1234,
  observedAt: 1500,
  outcome: 'stored',
  tokenRecorded: false,
  metadata: { accessible: true, synchronizable: false },
}

test('accepts native credential storage observed by the current build and process', () => {
  assert.equal(validateCredentialReport(report, context), report)
})

test('rejects stale, incomplete, unsafe and foreign credential evidence', () => {
  for (const change of [
    { runId: 'another-run' },
    { phase: 'read' },
    { build: 'old' },
    { pid: 1235 },
    { observedAt: 999 },
    { outcome: 'failed' },
    { tokenRecorded: true },
    { metadata: { accessible: false, synchronizable: false } },
    { metadata: { accessible: true, synchronizable: true } },
    { credential: 'must-not-be-published' },
  ])
    assert.throws(() => validateCredentialReport({ ...report, ...change }, context))
  assert.throws(() => validateCredentialReport(null, context))
  assert.throws(() => validateCredentialReport(report, { ...context, pid: undefined }))
})

test('requires unrelated item preservation during sign-out', () => {
  const signedOut = { ...report, phase: 'sign-out', outcome: 'signed-out' }
  const expected = { ...context, phase: 'sign-out' }
  assert.throws(() => validateCredentialReport(signedOut, expected))
  assert.doesNotThrow(() =>
    validateCredentialReport({ ...signedOut, unrelatedPreserved: true }, expected),
  )
})

test('preserves failure observations without copying raw token or error fields', () => {
  const receipt = summarizeCredentialReport({
    ...report,
    outcome: 'failed',
    error: 'private-token',
    credential: 'private-token',
  })
  assert.equal(receipt.outcome, 'failed')
  assert.equal(receipt.nativeErrorReported, true)
  assert.ok(!JSON.stringify(receipt).includes('private-token'))
})

test('observes a complete report when publication overlaps polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'holi770-observation-'))
  try {
    const target = join(dir, 'report.json'),
      pending = join(dir, 'report.pending')
    const observed = waitForCredentialReport(target, { timeout: 5000 })
    await writeFile(pending, '{"outcome":')
    await appendFile(pending, '"stored"}')
    await rename(pending, target)
    assert.deepEqual(await observed, { outcome: 'stored' })
    await writeFile(target, 'invalid')
    await assert.rejects(waitForCredentialReport(target))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
