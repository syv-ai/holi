import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitError, openRepo } from '../src/main/git'
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

  it('rejects schema-shaped arrays and invalid baseline lengths without changing bytes', async () => {
    const root = await fixture()
    const file = join(root, 'state.json')
    const manager = createSubscriptions(file)
    for (const text of [
      '{"version":1,"remotes":[]}',
      `{"version":1,"remotes":{"one/repo":[{"path":"","baseline":"${'a'.repeat(41)}"}]}}`,
    ]) {
      await writeFile(file, text)
      await expect(manager.set('one/repo', root, '', true, async () => null)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(text)
    }
  })

  it('serializes the full enable/disable intent and captures one valid baseline', async () => {
    const root = await fixture()
    const manager = createSubscriptions(join(root, 'state.json'))
    let releaseHead!: (sha: string | null) => void
    const delayedHead = new Promise<string | null>((resolve) => (releaseHead = resolve))
    const enable = manager.set('one/repo', root, '', true, () => delayedHead)
    await Promise.resolve()
    const disable = manager.set('one/repo', root, '', false, async () => null)
    releaseHead('a'.repeat(40))
    await Promise.all([enable, disable])
    expect(await manager.list('one/repo', root, [''])).toMatchObject([{ explicit: false }])

    let reads = 0
    await Promise.all([
      manager.set('one/repo', root, '', true, async () => {
        reads += 1
        return 'b'.repeat(40)
      }),
      manager.set('one/repo', root, '', true, async () => {
        reads += 1
        return 'c'.repeat(40)
      }),
    ])
    expect(reads).toBe(1)
    expect(await manager.list('one/repo', root, [''])).toMatchObject([
      { explicit: true, baseline: 'b'.repeat(40) },
    ])
    const disableThenEnableDisable = manager.set('one/repo', root, '', false, async () => null)
    const disableThenEnableEnable = manager.set('one/repo', root, '', true, async () =>
      'e'.repeat(40),
    )
    await Promise.all([disableThenEnableDisable, disableThenEnableEnable])
    expect(await manager.list('one/repo', root, [''])).toMatchObject([
      { explicit: true, baseline: 'e'.repeat(40) },
    ])
    await expect(
      manager.set('one/repo', root, 'notes', true, async () => 'd'.repeat(41)),
    ).rejects.toThrow('invalid HEAD')
  })

  it('returns null only for a verified unborn branch and rejects other HEAD failures', async () => {
    const unborn = await fixture(false)
    await expect(openRepo(unborn).head()).resolves.toBeNull()

    const notRepo = await mkdtemp(join(tmpdir(), 'holi-not-repo-'))
    roots.push(notRepo)
    await expect(openRepo(notRepo).head()).rejects.toBeInstanceOf(GitError)

    const corrupt = await fixture()
    await writeFile(join(corrupt, '.git', 'HEAD'), 'not a ref\n')
    await expect(openRepo(corrupt).head()).rejects.toBeInstanceOf(GitError)

    const missingObject = await fixture()
    await writeFile(join(missingObject, '.git', 'refs', 'heads', 'main'), `${'d'.repeat(40)}\n`)
    await expect(openRepo(missingObject).head()).rejects.toBeInstanceOf(GitError)
  })

  it('refuses directory symlink aliases', async () => {
    const root = await fixture()
    await symlink(join(root, 'notes'), join(root, 'alias'))
    const manager = createSubscriptions(join(root, 'state.json'))
    await expect(manager.set('one/repo', root, 'alias', true, async () => null)).rejects.toThrow()
  })
})
