import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkingCopyTreeFixture,
  verifyWorkingCopyTreeResults,
} from '../scripts/working-copy-tree-fixture.mjs'

describe('working-copy tree fixture', () => {
  it('verifies oracle bytes and unchanged repositories, rejecting missing, stale and mutated results', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'holi-tree-test-'))
    try {
      const fixture = await createWorkingCopyTreeFixture(
        parent,
        'host-test',
        join(parent, 'library'),
      )
      const mixed = fixture.cases.find((item) => item.name === 'mixed')
      assert.ok(
        mixed.expectedEntries.some(
          (entry) =>
            entry.path === 'binary.bin' &&
            entry.bytes === Buffer.from([0, 255, 1, 0]).toString('base64'),
        ),
      )
      assert.ok(
        mixed.expectedEntries.some((entry) => entry.path === 'run.sh' && entry.mode === '100755'),
      )
      assert.ok(
        !mixed.expectedEntries.some((entry) =>
          ['.env', 'TOKEN.LOCAL.bin', 'ignored-private.bin', 'gone.md'].includes(entry.path),
        ),
      )
      const noop = fixture.cases.find((item) => item.name === 'noop')
      const one = { cases: [noop] }
      const result = {
        name: noop.name,
        runId: noop.runId,
        root: noop.root,
        refused: false,
        tree: {
          treeOID: noop.expectedTree,
          parentOID: noop.baseHead,
          branch: noop.branch,
          unchanged: true,
        },
      }
      const proof = await verifyWorkingCopyTreeResults([result], one)
      assert.equal(proof[0].rawEntriesVerified, true)
      await assert.rejects(verifyWorkingCopyTreeResults([], one))
      await assert.rejects(verifyWorkingCopyTreeResults([{ ...result, root: mixed.root }], one))
      await assert.rejects(verifyWorkingCopyTreeResults([{ ...result, runId: 'stale' }], one))
      await writeFile(join(noop.root, 'note.md'), 'unexpected mutation')
      await assert.rejects(verifyWorkingCopyTreeResults([result], one))
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 20_000)
})
