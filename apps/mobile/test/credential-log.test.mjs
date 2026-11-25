import { test } from 'vitest'
import assert from 'node:assert/strict'
import { recordCredentialCommand } from '../scripts/credential-log.mjs'
import { runCommand } from '../scripts/host-checks.mjs'

test('publishes build and cleanup status without stdout, stderr or exception messages', async () => {
  const receipts = []
  const secret = 'synthetic-private-tool-output'
  await recordCredentialCommand(receipts, 'unsigned-build', () =>
    runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', secret]),
  )
  await assert.rejects(
    recordCredentialCommand(receipts, 'delete', () =>
      runCommand(process.execPath, [
        '-e',
        'console.error(process.argv[1]); process.exit(7)',
        secret,
      ]),
    ),
    (error) => error.exitCode === 7,
  )
  assert.deepEqual(
    receipts.map(({ stage, status, exitCode }) => ({ stage, status, exitCode })),
    [
      { stage: 'unsigned-build', status: 'ok', exitCode: 0 },
      { stage: 'delete', status: 'failed', exitCode: 7 },
    ],
  )
  assert.ok(receipts.every(({ durationMs }) => Number.isSafeInteger(durationMs) && durationMs >= 0))
  assert.ok(!JSON.stringify(receipts).includes(secret))
})
