import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { test } from 'vitest'
import {
  validateCredentialBuildIdentity,
  validateCredentialReport,
  summarizeCredentialReport,
  waitForCredentialReport,
} from '../scripts/credential-evidence.mjs'

const runId = 'e9c63bec-e162-4a5e-a66e-53a36e923c82'
const context = {
  runId,
  phase: 'store',
  build: '1',
  pid: 1234,
  launchedAt: 1000,
  now: 2000,
}
const report = {
  schemaVersion: 1,
  source: 'diagnostic-keychain-namespace',
  runId,
  phase: 'store',
  build: '1',
  pid: 1234,
  observedAt: 1500,
  outcome: 'stored',
  tokenRecorded: false,
  metadata: { accessible: true, synchronizable: false },
}

test('projects the exact built SDK and minimum OS into credential provenance', () => {
  const bundleId = 'ai.syv.holi.compatibility'
  const plist = {
    CFBundleIdentifier: bundleId,
    CFBundleExecutable: 'mobile',
    CFBundleVersion: '1.0.0',
    DTPlatformName: 'iphonesimulator',
    DTSDKName: 'iphonesimulator26.2',
    DTSDKBuild: '23C53',
    DTXcodeBuild: '17C52',
    MinimumOSVersion: '26.0',
    privateValue: 'must-not-be-published',
  }
  assert.deepEqual(validateCredentialBuildIdentity(plist, bundleId), {
    bundleId,
    build: '1.0.0',
    sdkName: 'iphonesimulator26.2',
    sdkBuild: '23C53',
    minimumOSVersion: '26.0',
  })
  for (const change of [
    { DTSDKName: undefined },
    { DTSDKName: 'iphoneos26.2' },
    { DTSDKBuild: undefined },
    { DTSDKBuild: '23C53\nprivate-value' },
    { MinimumOSVersion: '25.0' },
    { MinimumOSVersion: 26 },
  ])
    assert.throws(() => validateCredentialBuildIdentity({ ...plist, ...change }, bundleId))
})

test('accepts native credential storage observed by the current build and process', () => {
  assert.deepEqual(validateCredentialReport(report, context), report)
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

test('published proof contains only the applicable validated fields', () => {
  const privateValue = { secret: 'must-not-be-published' }
  const stored = {
    ...report,
    metadata: { ...report.metadata, extra: privateValue },
    unrelatedPreserved: privateValue,
  }
  assert.deepEqual(validateCredentialReport(stored, context), report)
  const { metadata, ...base } = report
  const signedOut = { ...base, phase: 'sign-out', outcome: 'signed-out', unrelatedPreserved: true }
  assert.deepEqual(
    validateCredentialReport(
      { ...signedOut, metadata: { ...metadata, extra: privateValue } },
      { ...context, phase: 'sign-out' },
    ),
    signedOut,
  )
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

test.skipIf(process.platform === 'win32')(
  'rejects a real FIFO report without a writer',
  async () => {
    const run = promisify(execFile)
    const dir = await mkdtemp(join(tmpdir(), 'holi770-fifo-'))
    try {
      const path = join(dir, 'report.json')
      const supervision = { timeout: 2000, killSignal: 'SIGKILL' }
      await run('mkfifo', [path], supervision)
      const script = `
      import assert from 'node:assert/strict';
      const { waitForCredentialReport } = await import(process.argv[1]);
      await assert.rejects(waitForCredentialReport(process.argv[2]), /Invalid or oversized evidence JSON/);
    `
      await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          new URL('../scripts/credential-evidence.mjs', import.meta.url).href,
          path,
        ],
        supervision,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('retains bounded native Keychain status without arbitrary error details', () => {
  const error = { kind: 'keychain', operation: 'read', status: -34018, message: 'private-token' }
  const receipt = summarizeCredentialReport({ ...report, outcome: 'failed', error })
  assert.deepEqual(receipt.nativeError, { kind: 'keychain', operation: 'read', status: -34018 })
  assert.ok(!JSON.stringify(receipt).includes('private-token'))
  assert.throws(() => validateCredentialReport({ ...report, outcome: 'failed', error }, context))
})
