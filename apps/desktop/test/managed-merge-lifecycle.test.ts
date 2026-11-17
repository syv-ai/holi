import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { createManagedCommitProvenance } from '../src/main/managed-commit-provenance'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeRemote,
  plainGit,
  tmp,
} from './helpers/git-fixtures'

const states: string[] = []
afterAll(async () => {
  await cleanupFixtures()
  await Promise.all(states.map((dir) => rm(dir, { recursive: true, force: true })))
})
async function state() {
  const dir = await mkdtemp(join(tmpdir(), 'holi-merge-provenance-'))
  states.push(dir)
  return dir
}

describe('managed merge provenance lifecycle', () => {
  it('persists only the exact owned merge across independent roots and recorder restart', async () => {
    const remote = await makeRemote()
    const local = await makeClone(remote, 'local')
    const teammate = await makeClone(remote, 'teammate')
    await commitFile(local, 'ours.md', 'ours\n')
    await commitFile(teammate, 'theirs.md', 'theirs\n')
    const incoming = await plainGit(teammate, ['rev-parse', 'HEAD'])
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    await plainGit(local, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
    const dir = await state()
    const file = join(dir, 'records.json')
    const recorder = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 1, generation: 1 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const fetcher = join(await tmp('holi-merge-fetch-'), 'git')
    await writeFile(
      fetcher,
      '#!/bin/sh\nif [ "$1" = fetch ]; then exec git fetch "$LOCAL_BARE_REMOTE" +refs/heads/*:refs/remotes/origin/*; fi\nexec git "$@"\n',
    )
    await chmod(fetcher, 0o755)
    const result = await openRepo(local, {
      gitPath: fetcher,
      env: { LOCAL_BARE_REMOTE: remote },
      commitProvenance: recorder,
    }).pull()
    expect(result.kind).toBe('merged')
    const records = JSON.parse(await readFile(file, 'utf8')).records as Array<{
      oid: string
      remote: string
      accountId: number
    }>
    const owned = await plainGit(local, ['rev-parse', 'HEAD'])
    expect(records).toEqual([
      expect.objectContaining({ oid: owned, remote: 'owner/repo', accountId: 1 }),
    ])
    expect(owned).not.toBe(incoming)
    const restarted = createManagedCommitProvenance({
      file,
      remote: 'owner/repo',
      identity: () => ({ accountId: 1, generation: 1 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const ticket = await restarted.begin(local)
    await restarted.record(ticket, local, owned)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(1)
  })

  it('isolates concurrent canonical roots and remotes in one durable ledger', async () => {
    const [remoteA, remoteB] = await Promise.all([makeRemote(), makeRemote()])
    const [localA, localB] = await Promise.all([
      makeClone(remoteA, 'local-a'),
      makeClone(remoteB, 'local-b'),
    ])
    const [teammateA, teammateB] = await Promise.all([
      makeClone(remoteA, 'teammate-a'),
      makeClone(remoteB, 'teammate-b'),
    ])
    await Promise.all([
      commitFile(localA, 'ours.md', 'ours a\n'),
      commitFile(localB, 'ours.md', 'ours b\n'),
      commitFile(teammateA, 'theirs.md', 'theirs a\n'),
      commitFile(teammateB, 'theirs.md', 'theirs b\n'),
    ])
    await Promise.all([
      plainGit(teammateA, ['push', 'origin', 'HEAD:main']),
      plainGit(teammateB, ['push', 'origin', 'HEAD:main']),
      plainGit(localA, ['remote', 'set-url', 'origin', 'https://github.com/owner/alpha.git']),
      plainGit(localB, ['remote', 'set-url', 'origin', 'https://github.com/owner/beta.git']),
    ])
    const file = join(await state(), 'records.json')
    const fetcher = join(await tmp('holi-merge-fetch-'), 'git')
    await writeFile(
      fetcher,
      '#!/bin/sh\nif [ "$1" = fetch ]; then exec git fetch "$LOCAL_BARE_REMOTE" +refs/heads/*:refs/remotes/origin/*; fi\nexec git "$@"\n',
    )
    await chmod(fetcher, 0o755)
    const makeRecorder = (remote: string) =>
      createManagedCommitProvenance({
        file,
        remote,
        identity: () => ({ accountId: 1, generation: 1 }),
        subscribed: async () => true,
        subscribedNow: () => true,
      })
    const [resultA, resultB] = await Promise.all([
      openRepo(localA, {
        gitPath: fetcher,
        env: { LOCAL_BARE_REMOTE: remoteA },
        commitProvenance: makeRecorder('owner/alpha'),
      }).pull(),
      openRepo(localB, {
        gitPath: fetcher,
        env: { LOCAL_BARE_REMOTE: remoteB },
        commitProvenance: makeRecorder('owner/beta'),
      }).pull(),
    ])
    expect([resultA.kind, resultB.kind]).toEqual(['merged', 'merged'])
    const records = JSON.parse(await readFile(file, 'utf8')).records as Array<{
      root: string
      remote: string
    }>
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.root)).size).toBe(2)
    expect(records.map((record) => record.remote).sort()).toEqual(['owner/alpha', 'owner/beta'])
    const restartedA = makeRecorder('owner/alpha')
    const ticketA = await restartedA.begin(localA)
    await restartedA.record(ticketA, localA, null)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toHaveLength(2)
    await expect(stat(file).then((entry) => entry.mode & 0o777)).resolves.toBe(0o600)
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('theirs a')
    expect(text).not.toContain('theirs b')
  })

  it.each(['logout', 'adoption', 'relogin', 'subscription', 'lifetime', 'origin'] as const)(
    'rejects publication after %s changes between merge evidence and recording',
    async (change) => {
      const remote = await makeRemote()
      const local = await makeClone(remote, 'local')
      const teammate = await makeClone(remote, 'teammate')
      await commitFile(local, 'ours.md', 'ours\n')
      await commitFile(teammate, 'theirs.md', 'theirs\n')
      await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
      await plainGit(local, ['remote', 'set-url', 'origin', 'https://github.com/owner/repo.git'])
      const file = join(await state(), 'records.json')
      let identity: { accountId: number; generation: number } | null = {
        accountId: 1,
        generation: 1,
      }
      let subscribed = true
      const recorder = createManagedCommitProvenance({
        file,
        remote: 'owner/repo',
        identity: () => identity,
        subscribed: async () => subscribed,
        subscribedNow: () => subscribed,
      })
      const marker = join(local, '.git/holi-managed-provenance-id')
      const before = await readFile(marker, 'utf8').catch(() => null)
      const wrapped = {
        begin: (root: string) => recorder.begin(root),
        record: async (ticket: unknown, root: string, oid: string | null): Promise<void> => {
          if (change === 'logout') identity = null
          if (change === 'adoption') identity = { accountId: 2, generation: 2 }
          if (change === 'relogin') identity = { accountId: 1, generation: 2 }
          if (change === 'subscription') subscribed = false
          if (change === 'lifetime') await writeFile(marker, `${before ?? 'old'}\nreplacement\n`)
          if (change === 'origin')
            await plainGit(root, [
              'remote',
              'set-url',
              'origin',
              'https://github.com/other/repo.git',
            ])
          await recorder.record(ticket, root, oid)
        },
      }
      const fetcher = join(await tmp('holi-merge-fetch-'), 'git')
      await writeFile(
        fetcher,
        '#!/bin/sh\nif [ "$1" = fetch ]; then exec git fetch "$LOCAL_BARE_REMOTE" +refs/heads/*:refs/remotes/origin/*; fi\nexec git "$@"\n',
      )
      await chmod(fetcher, 0o755)
      expect(
        (
          await openRepo(local, {
            gitPath: fetcher,
            env: { LOCAL_BARE_REMOTE: remote },
            commitProvenance: wrapped,
          }).pull()
        ).kind,
      ).toBe('merged')
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
