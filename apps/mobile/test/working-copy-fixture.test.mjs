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
    const libraryRoot = join(parent, 'library')
    const { cases } = await createWorkingCopyFixture(parent, 'host-test', libraryRoot)
    assert.equal(new Set(cases.map(({ root }) => root)).size, cases.length)
    const staged = cases.find(({ name }) => name === 'staged')
    const clean = cases.find(({ name }) => name === 'clean')
    assert.ok(
      staged.expectedChanges.some(({ path, index }) => path === 'tracked.md' && index === 'M'),
    )
    assert.equal(clean.expectedChanges.length, 0)
    assert.ok(cases.some(({ name }) => name === 'autocrlf'))
    assert.ok(cases.some(({ name }) => name === 'skip-worktree'))
    assert.equal(cases.find(({ name }) => name === 'identity').expectedRefusal, true)
    assert.equal(cases.find(({ name }) => name === 'unsafe-config').expectedChanges, null)
    assert.ok(cases.find(({ name }) => name === 'autocrlf').expectedRefusal)
    assert.ok(cases.find(({ name }) => name === 'skip-worktree').expectedRefusal)
    assert.ok(
      cases
        .find(({ name }) => name === 'ignored-untracked')
        .expectedChanges.every(({ path }) => path !== 'ignored.md'),
    )
    assert.ok(
      cases
        .find(({ name }) => name === 'spaced-name')
        .expectedChanges.some(({ path }) => path === 'notes with spaces.md'),
    )
    for (const fixture of cases.filter((item) => item.name.startsWith('pending-'))) {
      assert.equal(fixture.expectedRefusal, true, `${fixture.name} has pending recovery`)
      assert.equal(fixture.recovery.length, 1)
    }
    assert.ok(cases.find(({ name }) => name === 'file-directory').expectedChanges.length > 0)
    const before = await snapshotWorkingCopy(staged.root)
    assert.equal(await verifyWorkingCopyUnchanged(staged.root, before), true)
    assert.equal(await verifyWorkingCopyUnchanged(staged.root, []), false)
  })
})
