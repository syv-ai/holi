import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkingCopyFixture } from '../scripts/working-copy-fixture.mjs'

describe('working-copy fixture', () => {
  let parent
  afterEach(async () => {
    if (parent) await rm(parent, { recursive: true, force: true })
  })

  it('provides an offline repository with a logical identity and plumbing baselines', async () => {
    parent = await mkdtemp(join(tmpdir(), 'holi-working-copy-'))
    const fixture = await createWorkingCopyFixture(parent, 'host-test')
    assert.equal(fixture.remote, 'fixture/vault')
    assert.equal(fixture.branch, 'fixture-start')
    assert.deepEqual(fixture.results.map(({ name }) => name), [
      'staged',
      'unstaged',
      'addition',
      'deletion',
    ])
    assert.ok(fixture.results.every(({ changes }) => changes.length > 0))
  })
})
