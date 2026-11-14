import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { createSubscriptions } from '../src/main/vault/subscriptions'

const exec = promisify(execFile)
const roots: string[] = []

async function fixture(withCommit = true) {
  const root = await mkdtemp(join(tmpdir(), 'holi-subscriptions-'))
  roots.push(root)
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes', '.gitkeep'), '')
  if (withCommit) {
    await writeFile(join(root, 'README.md'), 'initial')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '-qm', 'initial'])
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('machine-local subscriptions', () => {
  it('captures one baseline, keeps independent overlapping scopes, isolates remotes and survives restart', async () => {
    const root = await fixture()
    const file = join(root, 'outside-state.json')
    let head = await openRepo(root).head()
    const manager = createSubscriptions(file)
    await manager.set('one/repo', root, '', true, async () => head)
    await manager.set('one/repo', root, 'notes', true, async () => head)
    await exec('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'later'])
    head = await openRepo(root).head()
    await manager.set('one/repo', root, '', true, async () => head)
    await manager.set('two/repo', root, '', true, async () => head)
    const afterRestart = createSubscriptions(file)
    const state = await afterRestart.list('one/repo', root, ['', 'notes'], async () => head)
    expect(state).toEqual([
      { path: '', explicit: true, coveredBy: null, baseline: expect.any(String) },
      { path: 'notes', explicit: true, coveredBy: '', baseline: expect.any(String) },
    ])
    expect(state[0]?.baseline).not.toBe(head)
    await afterRestart.set('one/repo', root, '', false, async () => head)
    expect(
      await afterRestart.list('one/repo', root, ['', 'notes'], async () => head),
    ).toMatchObject([
      { path: '', explicit: false },
      { path: 'notes', explicit: true, coveredBy: null },
    ])
    expect(await afterRestart.list('two/repo', root, [''], async () => head)).toMatchObject([
      { explicit: true },
    ])
  })

  it('represents an unborn repository with a pending baseline and rejects unsafe/missing paths', async () => {
    const root = await fixture(false)
    const manager = createSubscriptions(join(root, 'state.json'))
    await manager.set('one/repo', root, '', true, async () => null)
    await expect(
      manager.list('one/repo', root, ['', 'missing'], async () => null),
    ).rejects.toThrow()
    expect(await manager.list('one/repo', root, [''], async () => null)).toMatchObject([
      { explicit: true, baseline: null },
    ])
    await expect(
      manager.set('one/repo', root, '../other', true, async () => null),
    ).rejects.toThrow()
    await expect(manager.set('one/repo', root, '.env', true, async () => null)).rejects.toThrow()
  })

  it('rejects corrupt state without replacing it and serializes concurrent updates', async () => {
    const root = await fixture()
    const file = join(root, 'state.json')
    await writeFile(file, '{broken')
    const manager = createSubscriptions(file)
    await expect(manager.set('one/repo', root, '', true, async () => null)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
    await rm(file)
    await Promise.all([
      manager.set('one/repo', root, '', true, async () => openRepo(root).head()),
      manager.set('one/repo', root, 'notes', true, async () => openRepo(root).head()),
    ])
    expect(await manager.list('one/repo', root, ['', 'notes'], async () => null)).toHaveLength(2)
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'block')
    await expect(
      createSubscriptions(join(blocked, 'state.json')).set('one/repo', root, '', true, async () =>
        openRepo(root).head(),
      ),
    ).rejects.toThrow()
  })

  it('refuses directory symlink aliases', async () => {
    const root = await fixture()
    await symlink(join(root, 'notes'), join(root, 'alias'))
    const manager = createSubscriptions(join(root, 'state.json'))
    await expect(manager.set('one/repo', root, 'alias', true, async () => null)).rejects.toThrow()
  })
})
