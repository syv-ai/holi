import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { createManagedCommitProvenance } from '../src/main/managed-commit-provenance'
import { createSubscriptions } from '../src/main/vault/subscriptions'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const states: string[] = []
afterAll(async () => {
  await cleanupFixtures()
  await Promise.all(states.map((dir) => rm(dir, { recursive: true, force: true })))
})
async function state() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-provenance-state-'))
  states.push(dir)
  return dir
}

describe('managed provenance lifecycle', () => {
  it.each(['sign-out', 'relogin', 'adoption'] as const)(
    'keeps a real completed commit unknown after %s',
    async (change) => {
      const root = await makeClone(await makeRemote())
      await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
      const file = join(await state(), 'records.json')
      let identity: { accountId: number; generation: number } | null = {
        accountId: 1,
        generation: 1,
      }
      const recorder = createManagedCommitProvenance({
        file,
        remote: 'owner/repo',
        identity: () => identity,
        subscribed: async () => true,
        subscribedNow: () => true,
      })
      await writeFile(join(root, 'same.md'), 'same\n')
      const oid = await openRepo(root, {
        commitProvenance: {
          begin: (path) => recorder.begin(path),
          record: async (ticket, path, exact) => {
            identity =
              change === 'sign-out'
                ? null
                : { accountId: change === 'adoption' ? 2 : 1, generation: 2 }
            await recorder.record(ticket, path, exact)
          },
        },
      }).commitAll('managed', ['same.md'])
      expect(oid).toMatch(/^[0-9a-f]{40}$/)
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await plainGit(root, ['rev-list', '--count', 'HEAD'])).toBe('2')
    },
  )

  it('serializes independent handles and isolates canonical roots and remotes in protected state', async () => {
    const file = join(await state(), 'records.json')
    const roots = await Promise.all([
      makeClone(await makeRemote()),
      makeClone(await makeRemote()),
      makeClone(await makeRemote()),
    ])
    const remotes = ['one/repo', 'one/repo', 'two/repo']
    const oids = await Promise.all(
      roots.map(async (root, i) => {
        const remote = remotes[i]!
        await plainGit(root, ['remote', 'set-url', 'origin', `https://github.com/${remote}.git`])
        const recorder = createManagedCommitProvenance({
          file,
          remote,
          identity: () => ({ accountId: i + 1, generation: 1 }),
          subscribed: async () => true,
          subscribedNow: () => true,
        })
        await writeFile(join(root, 'same.md'), 'private document content\n')
        return openRepo(root, { commitProvenance: recorder }).commitAll('managed', ['same.md'])
      }),
    )
    const text = await readFile(file, 'utf8')
    const records = JSON.parse(text).records as Array<{ oid: string; root: string; remote: string }>
    expect(records).toHaveLength(3)
    expect(new Set(records.map((record) => record.root)).size).toBe(3)
    expect(records.map((record) => record.oid).sort()).toEqual(oids.sort())
    expect(records.filter((record) => record.remote === 'one/repo')).toHaveLength(2)
    expect(text).not.toContain('private document content')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await plainGit(roots[0]!, ['commit', '--allow-empty', '-m', 'manual'])
    expect(await readFile(file, 'utf8')).toBe(text)
  })

  it('preserves a successful commit and does not retry when protected persistence fails', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const blocker = join(await state(), 'blocker')
    await writeFile(blocker, 'not a directory')
    const recorder = createManagedCommitProvenance({
      file: join(blocker, 'records.json'),
      remote: 'owner/repo',
      identity: () => ({ accountId: 1, generation: 1 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    await writeFile(join(root, 'note.md'), 'saved\n')
    const oid = await openRepo(root, { commitProvenance: recorder }).commitAll('managed', [
      'note.md',
    ])
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    expect(await plainGit(root, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(await plainGit(root, ['status', '--porcelain'])).toBe('')
    expect(await readFile(blocker, 'utf8')).toBe('not a directory')
  })

  it('uses current validated explicit subscription bytes, not another handle or a stale cache', async () => {
    const root = await makeClone(await makeRemote())
    const file = join(await state(), 'subscriptions.json')
    const first = createSubscriptions(file)
    const second = createSubscriptions(file)
    expect(first.hasExplicitNow('owner/repo')).toBe(false)
    await second.set('owner/repo', root, '', true, () => openRepo(root).head())
    expect(first.hasExplicitNow('owner/repo')).toBe(true)
    expect(first.hasExplicitNow('other/repo')).toBe(false)
    await second.set('owner/repo', root, '', false, async () => null)
    expect(first.hasExplicitNow('owner/repo')).toBe(false)
    await writeFile(file, '{ broken')
    expect(first.hasExplicitNow('owner/repo')).toBe(false)
  })
})
