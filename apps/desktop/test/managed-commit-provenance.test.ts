import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createManagedCommitProvenance } from '../src/main/managed-commit-provenance'
import { openRepo } from '../src/main/git'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const roots: string[] = []

afterAll(async () => {
  await cleanupFixtures()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function stateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-581-provenance-'))
  roots.push(dir)
  return join(dir, 'state.json')
}

describe('managed commit provenance', () => {
  it('persists exact real managed commits and rejects a changed session generation', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    let identity: { accountId: number; generation: number } | null = {
      accountId: 31,
      generation: 4,
    }
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => identity,
      subscribed: async () => true,
    })
    await writeFile(join(root, 'note.md'), 'committed\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: (path) => recorder.begin(path),
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('Update note', ['note.md'])
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const saved = JSON.parse(await readFile(file, 'utf8')) as {
      records: Array<{ oid: string; accountId: number }>
    }
    expect(saved.records).toHaveLength(1)
    expect(saved.records[0]).toMatchObject({ oid, accountId: 31 })

    const capture = await recorder.begin(root)
    identity = { accountId: 31, generation: 5 }
    await recorder.record(capture, root, 'b'.repeat(40))
    const afterRelogin = JSON.parse(await readFile(file, 'utf8')) as {
      records: Array<{ oid: string }>
    }
    expect(afterRelogin.records).toHaveLength(1)
  })

  it('rejects corrupt state rather than treating it as trusted empty history', async () => {
    const file = await stateFile()
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    await writeFile(file, '{ broken')
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 2, generation: 0 }),
      subscribed: async () => true,
    })
    const capture = await recorder.begin(root)
    await expect(recorder.record(capture, root, 'a'.repeat(40))).rejects.toThrow(/invalid/)
  })

  it('removes conflicting ownership for an identical commit object', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    let identity = { accountId: 41, generation: 0 }
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => identity,
      subscribed: async () => true,
    })
    await writeFile(join(root, 'same.md'), 'same\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: (path) => recorder.begin(path),
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('same object', ['same.md'])
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(1)
    identity = { accountId: 42, generation: 1 }
    const capture = await recorder.begin(root)
    await recorder.record(capture, root, oid)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual([])
  })

  it('does not accept a repository whose origin no longer matches its subscribed remote', async () => {
    const root = await makeClone(await makeRemote())
    const recorder = createManagedCommitProvenance({
      file: await stateFile(),
      remote: 'owner/repo',
      identity: () => ({ accountId: 3, generation: 1 }),
      subscribed: async () => true,
    })
    expect(await recorder.begin(root)).toBeNull()
  })

  it('rejects evidence after the repository lifetime marker is replaced', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 11, generation: 0 }),
      subscribed: async () => true,
    })
    const capture = await recorder.begin(root)
    await rm(join(root, '.git', 'holi-managed-provenance-id'))
    await recorder.record(capture, root, 'a'.repeat(40))
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not publish when identity changes during the final queued ownership check', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    let identity: { accountId: number; generation: number } | null = {
      accountId: 15,
      generation: 0,
    }
    let checks = 0
    let release!: (value: boolean) => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<boolean>((resolve) => (release = resolve))
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => identity,
      subscribed: async () => {
        checks += 1
        if (checks === 4) {
          entered()
          return gate
        }
        return true
      },
    })
    const capture = await recorder.begin(root)
    const recording = recorder.record(capture, root, 'a'.repeat(40))
    await waiting
    identity = null
    release(true)
    await recording
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not begin capture without an explicit subscription', async () => {
    const root = await makeClone(await makeRemote())
    const recorder = createManagedCommitProvenance({
      file: await stateFile(),
      remote: 'owner/repo',
      identity: () => ({ accountId: 18, generation: 0 }),
      subscribed: async () => false,
    })
    expect(await recorder.begin(root)).toBeNull()
  })

  it('rejects duplicate records in persisted state instead of picking a winner', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 19, generation: 0 }),
      subscribed: async () => true,
    })
    await writeFile(join(root, 'entry.md'), 'entry\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: (path) => recorder.begin(path),
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('entry', ['entry.md'])
    const saved = JSON.parse(await readFile(file, 'utf8')) as { records: unknown[] }
    await writeFile(
      file,
      JSON.stringify({ version: 1, records: [...saved.records, ...saved.records] }),
    )
    await expect(recorder.record(await recorder.begin(root), root, 'b'.repeat(40))).rejects.toThrow(
      /duplicate/i,
    )
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
  })
})
