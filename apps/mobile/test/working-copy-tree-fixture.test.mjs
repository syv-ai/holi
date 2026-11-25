import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkingCopyTreeFixture,
  verifyWorkingCopyTreeResults,
} from '../scripts/working-copy-tree-fixture.mjs'

describe('working-copy tree fixture', () => {
  it('provides independent expected trees and validates refusal/missing results', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'holi-tree-test-'))
    try {
      const fixture = await createWorkingCopyTreeFixture(
        parent,
        'host-test',
        join(parent, 'library'),
      )
      const results = fixture.cases.map((item) => ({
        name: item.name,
        runId: item.runId,
        tree: item.expectedTree,
        refused: item.refusal,
      }))
      assert.equal(await verifyWorkingCopyTreeResults(results, fixture), true)
      await assert.rejects(
        verifyWorkingCopyTreeResults(results.slice(1), fixture),
        /count mismatch/,
      )
      const bad = results.map((item) =>
        item.name === 'mixed' ? { ...item, tree: '0'.repeat(40) } : item,
      )
      await assert.rejects(verifyWorkingCopyTreeResults(bad, fixture), /tree mismatch/)
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 20_000)
})
