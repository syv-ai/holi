import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialLog } from '../scripts/credential-log.mjs'

test('caps durable output and reports observed and omitted bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holi770-log-test-'))
  try {
    const path = join(dir, 'build.log')
    const log = createCredentialLog(path, 4)
    log.write(Buffer.from('abc'))
    log.write(Buffer.from('def'))
    log.write(Buffer.from('ghi'))
    assert.deepEqual(log.close(), { limit: 4, observedBytes: 9, retainedBytes: 4, truncated: true })
    assert.equal(readFileSync(path, 'utf8'), 'abcd')
    assert.throws(() => createCredentialLog(path, 4))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
