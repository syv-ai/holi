import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { compareRevisions } from '../src/main/vault/compare-revisions'

const exec = promisify(execFile)
const roots: string[] = []
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'holi-revisions-'))
  roots.push(root)
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  return root
}
async function commit(root: string, message: string) {
  await exec('git', ['-C', root, 'add', '-A'])
  await exec('git', ['-C', root, 'commit', '-qm', message])
  return (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

describe('compareRevisions', () => {
  it('compares exact non-adjacent snapshots, preserving empty content and newlines', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), '')
    const first = await commit(root, 'empty')
    await writeFile(join(root, 'note.md'), 'intermediate')
    await commit(root, 'middle')
    await writeFile(join(root, 'note.md'), 'last\n\n')
    const last = await commit(root, 'last')
    await expect(compareRevisions(root, 'note.md', first, last)).resolves.toEqual({
      kind: 'text',
      before: '',
      after: 'last\n\n',
    })
  })

  it('preserves content equal to the old sentinel and ignores replacement refs', async () => {
    const root = await repository()
    await writeFile(join(root, 'note.md'), 'unsupported')
    const original = await commit(root, 'original')
    await writeFile(join(root, 'note.md'), 'replacement')
    const replacement = await commit(root, 'replacement')
    await exec('git', ['-C', root, 'replace', original, replacement])
    await expect(compareRevisions(root, 'note.md', original, original)).resolves.toEqual({
      kind: 'text',
      before: 'unsupported',
      after: 'unsupported',
    })
  })

  it('reports absent paths and rejects unsupported entries and invalid endpoints', async () => {
    const root = await repository()
    await mkdir(join(root, 'folder'))
    await writeFile(join(root, 'folder', 'inside'), 'x')
    const first = await commit(root, 'tree')
    await expect(compareRevisions(root, 'absent.md', first, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
    await expect(compareRevisions(root, 'folder', first, first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, 'folder/inside', 'f'.repeat(40), first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
    await expect(compareRevisions(root, '../note.md', first, first)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, '.env', first, first)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
    })
    await expect(compareRevisions(root, 'x', 'HEAD', first)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
    })
  })
})
