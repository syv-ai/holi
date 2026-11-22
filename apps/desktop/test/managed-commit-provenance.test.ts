import { cp, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  createManagedCommitProvenance,
  ownedCommitOids,
  repositoryPublicationSnapshot,
} from '../src/main/managed-commit-provenance'
import { openRepo } from '../src/main/git'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const observations = vi.hoisted(() => ({
  lifetime: null as (() => void) | null,
  origin: null as (() => void) | null,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args)
      if (String(args[0]).endsWith('/holi-managed-provenance-id')) observations.lifetime?.()
      return result
    },
  }
})
vi.mock('../src/main/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/git')>()
  return {
    ...actual,
    runGit: async (...args: Parameters<typeof actual.runGit>) => {
      const result = await actual.runGit(...args)
      if (args[1].includes('get-url')) observations.origin?.()
      return result
    },
  }
})

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
  it('looks up only durable exact-account records without creating repository identity', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 31, generation: 4 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    await writeFile(join(root, 'note.md'), 'evidence\n')
    const oid = await openRepo(root, {
      commitProvenance: {
        begin: (path) => recorder.begin(path),
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('managed', ['note.md'])
    const identity = repositoryPublicationSnapshot(root)!
    expect(identity).not.toBeNull()
    expect(
      ownedCommitOids({ file, remote: 'owner/repo', identity, accountId: 31, oids: [oid!] }),
    ).toEqual(new Set([oid]))
    expect(
      ownedCommitOids({ file, remote: 'owner/repo', identity, accountId: 32, oids: [oid!] }),
    ).toEqual(new Set())

    const fresh = await makeClone(await makeRemote())
    await plainGit(fresh, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const absentMarkerIdentity = repositoryPublicationSnapshot(fresh)!
    expect(absentMarkerIdentity).not.toBeNull()
    expect(absentMarkerIdentity.lifetime).toBeNull()
    expect(
      await readFile(join(absentMarkerIdentity.gitDir, 'holi-managed-provenance-id')).catch(
        () => null,
      ),
    ).toBeNull()
    expect(
      ownedCommitOids({
        file,
        remote: 'owner/repo',
        identity: absentMarkerIdentity,
        accountId: 31,
        oids: [oid!],
      }),
    ).toEqual(new Set())
  })
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
      subscribedNow: () => true,
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

  it('keeps restored identical commits writable across vaults and recorder restarts', async () => {
    const remote = await makeRemote()
    const root = await makeClone(remote)
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    const recorderFor = (remote: string) =>
      createManagedCommitProvenance({
        file,
        remote,
        identity: () => ({ accountId: 31, generation: 4 }),
        subscribed: async () => true,
        subscribedNow: () => true,
      })
    const recorder = recorderFor('owner/repo')
    // Back up the lifetime marker too, before either identical commit exists.
    expect(await recorder.begin(root)).not.toBeNull()
    const backup = join(dirname(file), 'backup')
    await cp(root, backup, { recursive: true })
    const originalInode = (await stat(join(root, '.git'))).ino
    const deps = {
      commitProvenance: recorder,
      env: {
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    }
    await writeFile(join(root, 'note.md'), 'same managed edit\n')
    const first = await openRepo(root, deps).commitAll('same managed operation', ['note.md'])
    expect(first).toMatch(/^[0-9a-f]{40}$/)
    // Retain the original directory so the filesystem cannot recycle its inode.
    await rename(root, join(dirname(file), 'old-root'))
    await cp(backup, root, { recursive: true })
    expect((await stat(join(root, '.git'))).ino).not.toBe(originalInode)
    await writeFile(join(root, 'note.md'), 'same managed edit\n')
    const second = await openRepo(root, deps).commitAll('same managed operation', ['note.md'])
    expect(second).toBe(first)
    const restored = JSON.parse(await readFile(file, 'utf8')).records
    expect(restored).toHaveLength(2)
    expect(restored[1]).toEqual({
      ...restored[0],
      inode: (await stat(join(root, '.git'))).ino,
    })

    const otherRoot = await makeClone(remote, 'other')
    await plainGit(otherRoot, ['remote', 'set-url', 'origin', 'https://github.com/other/vault.git'])
    await writeFile(join(otherRoot, 'other.md'), 'another vault\n')
    const other = await openRepo(otherRoot, {
      commitProvenance: recorderFor('other/vault'),
    }).commitAll('another vault', ['other.md'])
    expect(other).toMatch(/^[0-9a-f]{40}$/)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(3)

    const restarted = recorderFor('owner/repo')
    await expect(
      restarted.record(await restarted.begin(root), root, second),
    ).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(3)
    await writeFile(join(otherRoot, 'other.md'), 'after restart\n')
    const afterRestart = await openRepo(otherRoot, {
      commitProvenance: recorderFor('other/vault'),
    }).commitAll('after restart', ['other.md'])
    expect(afterRestart).toMatch(/^[0-9a-f]{40}$/)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual([
      ...restored,
      expect.objectContaining({ remote: 'other/vault', oid: other }),
      expect.objectContaining({ remote: 'other/vault', oid: afterRestart }),
    ])
  })

  it.each(['device', 'inode'] as const)(
    'keeps a different %s distinct during validation and insertion',
    async (field) => {
      const root = await makeClone(await makeRemote())
      await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
      const file = await stateFile()
      const args = {
        file,
        remote: 'owner/repo',
        identity: () => ({ accountId: 31, generation: 4 }),
        subscribed: async () => true,
        subscribedNow: () => true,
      }
      const recorder = createManagedCommitProvenance(args)
      await writeFile(join(root, 'note.md'), 'managed edit\n')
      const oid = await openRepo(root, { commitProvenance: recorder }).commitAll('managed', [
        'note.md',
      ])
      const saved = JSON.parse(await readFile(file, 'utf8'))
      const original = saved.records[0]
      const different = { ...original, [field]: original[field] + 1, accountId: 99 }
      await writeFile(file, JSON.stringify({ version: 1, records: [different] }))
      await recorder.record(await recorder.begin(root), root, oid)
      expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual([different, original])
      const restarted = createManagedCommitProvenance(args)
      await restarted.record(await restarted.begin(root), root, oid)
      expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual([different, original])
    },
  )

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
      subscribedNow: () => true,
    })
    const capture = await recorder.begin(root)
    await expect(recorder.record(capture, root, 'a'.repeat(40))).rejects.toThrow(/invalid/)
  })

  it('retains a conflict tombstone through a to b to a and fresh recorder handles', async () => {
    const root = await makeClone(await makeRemote())
    await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const file = await stateFile()
    let identity = { accountId: 41, generation: 0 }
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
        record: (capture, path, sha) => recorder.record(capture, path, sha),
      },
    }).commitAll('same object', ['same.md'])
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(1)
    identity = { accountId: 42, generation: 1 }
    const capture = await recorder.begin(root)
    await recorder.record(capture, root, oid)
    expect(
      JSON.parse(await readFile(file, 'utf8')).records.filter(
        (record: { conflicted?: boolean }) => !record.conflicted,
      ),
    ).toEqual([])
    identity = { accountId: 41, generation: 0 }
    const restarted = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => identity,
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    await restarted.record(await restarted.begin(root), root, oid)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toMatchObject([{ conflicted: true }])
  })

  it('does not accept a repository whose origin no longer matches its subscribed remote', async () => {
    const root = await makeClone(await makeRemote())
    const recorder = createManagedCommitProvenance({
      file: await stateFile(),
      remote: 'owner/repo',
      identity: () => ({ accountId: 3, generation: 1 }),
      subscribed: async () => true,
      subscribedNow: () => true,
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
      subscribedNow: () => true,
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
      subscribedNow: () => true,
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

  it.each(['unsubscribe', 'origin', 'replacement'] as const)(
    'rejects %s while an earlier publication observation is suspended',
    async (change) => {
      const root = await makeClone(await makeRemote())
      await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
      const file = await stateFile()
      let subscribed = true
      let armed = false
      let calls = 0
      let release!: (value: boolean) => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => (entered = resolve))
      const gate = new Promise<boolean>((resolve) => (release = resolve))
      let lifetimeReads = 0
      let originReads = 0
      let seenLifetime!: () => void
      let seenOrigin!: () => void
      const latestLifetime = new Promise<void>((resolve) => (seenLifetime = resolve))
      const latestOrigin = new Promise<void>((resolve) => (seenOrigin = resolve))
      observations.lifetime = () => {
        if (++lifetimeReads === 3) seenLifetime()
      }
      observations.origin = () => {
        if (++originReads === 3) seenOrigin()
      }
      const recorder = createManagedCommitProvenance({
        file,
        remote: 'owner/repo',
        identity: () => ({ accountId: 15, generation: 0 }),
        subscribedNow: () => subscribed,
        subscribed: async () => {
          if (armed && ++calls === 4) {
            await Promise.all([latestLifetime, latestOrigin])
            entered()
            return gate
          }
          return subscribed
        },
      })
      const capture = await recorder.begin(root)
      armed = true
      const recording = recorder.record(capture, root, 'a'.repeat(40)).catch(() => undefined)
      await waiting
      if (change === 'unsubscribe') subscribed = false
      if (change === 'origin')
        await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/other/repo.git'])
      if (change === 'replacement') {
        await rename(join(root, '.git'), join(root, '.git-old'))
        await plainGit(root, ['init'])
        await plainGit(root, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'])
      }
      release(true)
      await recording
      observations.lifetime = null
      observations.origin = null
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('does not begin capture without an explicit subscription', async () => {
    const root = await makeClone(await makeRemote())
    const recorder = createManagedCommitProvenance({
      file: await stateFile(),
      remote: 'owner/repo',
      identity: () => ({ accountId: 18, generation: 0 }),
      subscribed: async () => false,
      subscribedNow: () => false,
    })
    expect(await recorder.begin(root)).toBeNull()
  })

  it.each(['same owner', 'different owner', 'conflict tombstone'])(
    'rejects duplicate records with %s instead of picking a winner',
    async (duplicate) => {
      const root = await makeClone(await makeRemote())
      await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
      const file = await stateFile()
      const recorder = createManagedCommitProvenance({
        file,
        remote: 'owner/repo',
        identity: () => ({ accountId: 19, generation: 0 }),
        subscribed: async () => true,
        subscribedNow: () => true,
      })
      await writeFile(join(root, 'entry.md'), 'entry\n')
      const oid = await openRepo(root, {
        commitProvenance: {
          begin: (path) => recorder.begin(path),
          record: (capture, path, sha) => recorder.record(capture, path, sha),
        },
      }).commitAll('entry', ['entry.md'])
      const saved = JSON.parse(await readFile(file, 'utf8')) as {
        records: Array<Record<string, unknown>>
      }
      const repeated = { ...saved.records[0] }
      if (duplicate === 'different owner') repeated.accountId = 20
      if (duplicate === 'conflict tombstone') {
        delete repeated.accountId
        delete repeated.generation
        repeated.conflicted = true
      }
      const corruptText = JSON.stringify({ version: 1, records: [...saved.records, repeated] })
      await writeFile(file, corruptText)
      await expect(
        recorder.record(await recorder.begin(root), root, 'b'.repeat(40)),
      ).rejects.toThrow(/duplicate/i)
      expect(oid).toMatch(/^[0-9a-f]{40}$/)
      expect(await readFile(file, 'utf8')).toBe(corruptText)
      await expect(readFile(`${file}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
