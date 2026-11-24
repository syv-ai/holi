import { describe, it, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkingCopyFixture,
  snapshotWorkingCopy,
  verifyWorkingCopyUnchanged,
} from '../scripts/working-copy-fixture.mjs'

describe('working-copy fixture', () => {
  let parent
  afterEach(async () => {
    if (parent) await rm(parent, { recursive: true, force: true })
  })

  it('creates independent persistent repositories with host-derived expectations', async () => {
    parent = await mkdtemp(join(tmpdir(), 'holi-working-copy-'))
    const { cases } = await createWorkingCopyFixture(parent, 'host-test')
    assert.ok(cases.length >= 16)
    assert.equal(new Set(cases.map(({ root }) => root)).size, cases.length)
    const staged = cases.find(({ name }) => name === 'staged')
    const clean = cases.find(({ name }) => name === 'clean')
    assert.ok(
      staged.expectedChanges.some(({ path, index }) => path === 'tracked.md' && index === 'M'),
    )
    assert.deepEqual(clean.expectedChanges, [])
    assert.equal(cases.find(({ name }) => name === 'identity').expectedRefusal, true)
    assert.equal(cases.find(({ name }) => name === 'unsafe-config').expectedChanges, null)
    assert.ok(cases.find(({ name }) => name === 'file-directory').expectedChanges.length > 0)
    const before = await snapshotWorkingCopy(staged.root)
    assert.equal(await verifyWorkingCopyUnchanged(staged.root, before), true)
    assert.equal(await verifyWorkingCopyUnchanged(staged.root, []), false)
  })
})
