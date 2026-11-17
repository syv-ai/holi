import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { repositoryPublicationSnapshot } from '../src/main/managed-commit-provenance'
import { openRepo } from '../src/main/git'
import { subscriptionChanges } from '../src/main/vault/subscription-changes'
import {
  cleanupFixtures,
  makeClone,
  makeEmptyRemote,
  makeRemote,
  plainGit,
} from './helpers/git-fixtures'

const roots: string[] = []
afterAll(async () => {
  await cleanupFixtures()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await makeClone(await makeRemote())
  roots.push(root)
  await writeFile(join(root, 'note.md'), 'note\n')
  await plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/Owner/Notes.git'])
  const baseline = 'a'.repeat(40)
  const tip = 'b'.repeat(40)
  const scope = { path: '', baseline }
  const changes = [{ sha: tip, path: 'note.md' }]
  const repo = {
    historicalHead: async () => ({ kind: 'commit' as const, sha: tip }),
    revisionChanges: async () => ({
      complete: true,
      reason: 'ok' as const,
      changes,
    }),
  }
  let reads = 0
  let onFinalScope: ((root: string) => Promise<void>) | undefined
  const currentScope = async () => {
    reads++
    if (reads === 2) await onFinalScope?.(root)
    return scope
  }
  return {
    root,
    scope,
    changes,
    run: (callback?: (root: string) => Promise<void>) => {
      onFinalScope = callback
      return subscriptionChanges({
        repo: repo as never,
        root,
        remote: 'Owner/Notes',
        baseline,
        path: '',
        provenanceFile: join(root, 'missing-provenance.json'),
        accountId: 9,
        current: () => true,
        currentScope,
      })
    },
  }
}

describe('subscription change publication guard', () => {
  it('keeps bounded local HEAD capture distinct for unborn and missing-object repositories', async () => {
    const unborn = await makeClone(await makeEmptyRemote())
    roots.push(unborn)
    expect(await openRepo(unborn).historicalHead()).toEqual({ kind: 'unborn' })

    const missing = await makeClone(await makeRemote())
    roots.push(missing)
    const branch = (await plainGit(missing, ['symbolic-ref', '--quiet', 'HEAD'])).trim()
    const gitDir = (await plainGit(missing, ['rev-parse', '--absolute-git-dir'])).trim()
    const looseRef = join(gitDir, branch)
    await mkdir(join(looseRef, '..'), { recursive: true })
    await writeFile(looseRef, `${'f'.repeat(40)}\\n`)
    expect(await openRepo(missing).historicalHead()).toEqual({ kind: 'unavailable' })
  })

  it('canonicalizes a case-preserved GitHub remote without changing the saved scope key', async () => {
    const f = await fixture()
    const result = await f.run()
    expect(result.history).toBe('ok')
    expect(result.changes).toEqual([
      { sha: 'b'.repeat(40), path: 'note.md', ownership: 'unknown', reviewed: false },
    ])
    expect(f.scope).toEqual({ path: '', baseline: 'a'.repeat(40) })
  })

  it('filters OS junk, Holi temporary files, secret and local-only history paths', async () => {
    const f = await fixture()
    f.changes.push(
      { sha: 'b'.repeat(40), path: '.DS_Store' },
      { sha: 'b'.repeat(40), path: 'Thumbs.db' },
      { sha: 'b'.repeat(40), path: 'notes/.holi-tmp-dead' },
      { sha: 'b'.repeat(40), path: '.env' },
      { sha: 'b'.repeat(40), path: 'USER.local.md' },
    )
    const result = await f.run()
    expect(result.changes.map(({ path }) => path)).toEqual(['note.md'])
  })

  it('rejects a repository replacement while historical HEAD is pending', async () => {
    const f = await fixture()
    const replacement = await makeClone(await makeRemote())
    roots.push(replacement)
    await plainGit(replacement, [
      'remote',
      'set-url',
      'origin',
      'https://github.com/Owner/Notes.git',
    ])
    const repo = {
      historicalHead: async () => {
        const moved = `${f.root}.old`
        roots.push(moved)
        await rename(f.root, moved)
        await rename(replacement, f.root)
        return { kind: 'commit' as const, sha: 'b'.repeat(40) }
      },
      revisionChanges: async () => ({ complete: true, reason: 'ok' as const, changes: f.changes }),
    }
    const result = await subscriptionChanges({
      repo: repo as never,
      root: f.root,
      remote: 'Owner/Notes',
      baseline: f.scope.baseline,
      path: '',
      provenanceFile: join(f.root, 'missing-provenance.json'),
      accountId: 9,
      current: () => true,
      currentScope: async () => f.scope,
    })
    expect(result.history).toBe('unavailable')
    expect(result.changes).toEqual([])
  })

  it('rejects a path ancestor swapped during the final awaited scope read', async () => {
    const f = await fixture()
    const outside = `${f.root}.outside`
    roots.push(outside)
    await writeFile(outside, 'outside')
    const result = await f.run(async (root) => {
      await rename(join(root, 'note.md'), join(root, 'note-old.md'))
      await symlink(outside, join(root, 'note.md'))
    })
    expect(result.history).toBe('ok')
    expect(result.changes).toEqual([])
  })

  it('rejects an origin changed during the final awaited scope read', async () => {
    const f = await fixture()
    const result = await f.run(async (root) =>
      plainGit(root, ['remote', 'set-url', 'origin', 'https://github.com/other/repo.git']),
    )
    expect(result.history).toBe('unavailable')
    expect(result.changes).toEqual([])
  })

  it('rejects a repository replacement during the final awaited scope read', async () => {
    const f = await fixture()
    const replacement = await makeClone(await makeRemote())
    roots.push(replacement)
    await plainGit(replacement, [
      'remote',
      'set-url',
      'origin',
      'https://github.com/Owner/Notes.git',
    ])
    const moved = `${f.root}.old`
    roots.push(moved)
    const result = await f.run(async () => {
      await rename(f.root, moved)
      await rename(replacement, f.root)
    })
    expect(result.history).toBe('unavailable')
    expect(result.changes).toEqual([])
  })

  it('keeps malformed markers unknown and rejects a marker changed during final scope read', async () => {
    const malformedFixture = await fixture()
    const initial = repositoryPublicationSnapshot(malformedFixture.root)!
    await writeFile(join(initial.gitDir, 'holi-managed-provenance-id'), 'not-a-uuid\n')
    const malformed = repositoryPublicationSnapshot(malformedFixture.root)!
    expect(malformed.lifetime).toBeNull()
    expect(malformed.marker).not.toBe(initial.marker)
    const unknown = await malformedFixture.run()
    expect(unknown.history).toBe('ok')
    expect(unknown.changes[0]?.ownership).toBe('unknown')

    const f = await fixture()
    const marker = repositoryPublicationSnapshot(f.root)!
    const result = await f.run(async () => {
      await writeFile(join(marker.gitDir, 'holi-managed-provenance-id'), 'changed-marker\n')
    })
    expect(result.history).toBe('unavailable')
    expect(result.changes).toEqual([])
  })
})
