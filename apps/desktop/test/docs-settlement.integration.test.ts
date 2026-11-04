import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCoreServices } from '../src/main/capabilities/services'
import { openRepo, type GitRepo } from '../src/main/git'
import { VAULT_NAMESPACES, vaultCapabilities } from '../src/main/capabilities/vault-caps'
import type { SyncState } from '@holi/shared'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { scanVault } from '../src/main/vault/vault-store'
import {
  cleanupFixtures,
  commitFile,
  makeClone,
  makeEmptyRemote,
  makeRemote,
  plainGit,
} from './helpers/git-fixtures'

const REMOTE = 'owner/repo'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
afterAll(cleanupFixtures)

function realRepoServices(root: string, push?: (repo: GitRepo) => Promise<void>) {
  const repo = openRepo(root)
  return createCoreServices({
    active: () => ({
      remote: REMOTE,
      root,
      syncState: () => ({ kind: 'up-to-date' as const }),
      heldBack: () => [],
      deliverNow: async (_path, verify) => {
        await repo.commitAll('CLI note mutation', ['integration.md'])
        if (!(await verify())) return false
        if (push) await push(repo)
        else await repo.push()
        return true
      },
    }),
    reports: { get: () => ({ focusedPath: null, openPaths: [], recents: [] }) } as never,
    members: { get: async () => [] } as never,
  })(REMOTE, root)
}

describe('CLI note settlement with a real local origin', () => {
  it('settles create, update and delete only after the matching commit reaches upstream; pending changes retry', async () => {
    const origin = await makeRemote()
    const root = await makeClone(origin, 'docs-settlement')
    const upstream = await plainGit(root, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]).catch(async () => {
      await plainGit(root, ['branch', '--set-upstream-to=origin/main', 'main'])
      return 'origin/main'
    })
    expect(upstream).toBe('origin/main')

    let state: SyncState = { kind: 'up-to-date' }
    let snapshot = await scanVault(root, [])
    let active: any
    active = {
      remote: REMOTE,
      root,
      syncState: () => state,
      heldBack: () => [],
      deliverNow: async (_path, verify) => {
        await plainGit(root, ['add', '-A'])
        const changed = await plainGit(root, ['diff', '--cached', '--quiet']).then(
          () => false,
          () => true,
        )
        if (changed) await plainGit(root, ['commit', '-m', 'CLI note mutation'])
        if (!(await verify())) return false
        if (state.kind === 'offline' || state.kind === 'no-access')
          throw new Error('remote rejected')
        await plainGit(root, ['push', 'origin', 'HEAD:main'])
        return true
      },
      snapshot: () => snapshot,
      refresh: async () => {
        snapshot = await scanVault(root, [])
      },
    }
    const reports = { get: () => ({ focusedPath: null, openPaths: [], recents: [] }) }
    const core = createCoreServices({
      active: () => active,
      reports: reports as never,
      members: { get: async () => [] } as never,
    })
    const registry = createCapabilityRegistry()
    registry.register(
      VAULT_NAMESPACES,
      vaultCapabilities({
        updateSkills: async () => ({ summary: '', conflicts: null }),
        pendingSkills: async () => [],
      }),
    )
    const host = createCapabilityHost({
      registry,
      rootFor: async () => root,
      active: () => active,
      core,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const call = (name: string, params: Record<string, unknown>) =>
      host.dispatch({ door: 'cli', remote: REMOTE, name, params })
    const receipt = async (name: string, params: Record<string, unknown>) =>
      (await call(name, params)).value as { pushed: boolean; commitSha: string | null }

    const empty = await receipt('docs.create', { path: 'integration.md', body: '' })
    expect(empty.pushed).toBe(true)
    expect(await readFile(join(root, 'integration.md'), 'utf8')).toBe('')
    const filled = await receipt('docs.update', {
      path: 'integration.md',
      revision: digest(''),
      body: 'first',
    })
    expect(filled.pushed).toBe(true)
    const cleared = await receipt('docs.update', {
      path: 'integration.md',
      revision: digest('first'),
      body: '',
    })
    expect(cleared.pushed).toBe(true)
    const restored = await receipt('docs.update', {
      path: 'integration.md',
      revision: digest(''),
      body: 'first',
    })
    expect(restored.pushed).toBe(true)
    const current = digest('first')
    state = { kind: 'paused', reason: 'test pause' }
    const updated = await receipt('docs.update', {
      path: 'integration.md',
      revision: current,
      body: 'second',
    })
    expect(updated).toMatchObject({ pushed: false, commitSha: null })
    expect(await readFile(join(root, 'integration.md'), 'utf8')).toBe('second')
    state = { kind: 'up-to-date' }
    const retried = await receipt('docs.settle', {
      path: 'integration.md',
      revision: digest('second'),
    })
    expect(retried.pushed).toBe(true)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(retried.commitSha)
    state = { kind: 'offline', count: 1 }
    const offline = await receipt('docs.update', {
      path: 'integration.md',
      revision: digest('second'),
      body: 'third',
    })
    expect(offline.pushed).toBe(false)
    state = { kind: 'up-to-date' }
    const recovered = await receipt('docs.settle', {
      path: 'integration.md',
      revision: digest('third'),
    })
    expect(recovered.pushed).toBe(true)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(recovered.commitSha)
    const removed = await receipt('docs.delete', {
      path: 'integration.md',
      revision: digest('third'),
    })
    expect(removed.pushed).toBe(true)
    expect(
      await plainGit(origin, ['cat-file', '-e', 'refs/heads/main:integration.md']).catch(() => ''),
    ).toBe('')
    active = null
    expect(await core(REMOTE, root).settle('integration.md', null)).toMatchObject({
      pushed: false,
      reason: 'vault-not-open',
    })
  })

  it('settles Git-normalized CRLF notes with a retriable worktree revision', async () => {
    const origin = await makeRemote()
    const root = await makeClone(origin, 'docs-normalized')
    await plainGit(root, ['config', 'core.autocrlf', 'true'])
    const body = 'first\r\nsecond\r\n'
    await writeFile(join(root, 'integration.md'), body)
    let offline = true
    const core = realRepoServices(root, async (repo) => {
      if (offline) throw new Error('offline')
      await repo.push()
    })

    const pending = await core.settle('integration.md', digest(body))
    expect(pending).toMatchObject({ pushed: false, phase: 'push', revision: digest(body) })
    expect(await plainGit(root, ['show', 'HEAD:integration.md'])).toBe('first\nsecond')
    expect(await readFile(join(root, 'integration.md'), 'utf8')).toBe(body)
    offline = false
    const delivered = await core.settle('integration.md', pending.revision!)
    expect(delivered).toMatchObject({ pushed: true, phase: 'complete', revision: digest(body) })
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(delivered.commitSha)
  })

  it('rejects a lossy clean filter before pushing', async () => {
    const origin = await makeRemote()
    const root = await makeClone(origin, 'docs-clean-filter')
    const originHead = await plainGit(origin, ['rev-parse', 'refs/heads/main'])
    await plainGit(root, ['config', 'filter.strip.clean', "sed '/REMOVE_ME/d'"])
    await writeFile(join(root, '.git', 'info', 'attributes'), 'integration.md filter=strip\n')
    const body = 'keep this\nREMOVE_ME\nkeep this too\n'
    await writeFile(join(root, 'integration.md'), body)
    let pushes = 0
    const core = realRepoServices(root, async (repo) => {
      pushes++
      await repo.push()
    })

    const result = await core.settle('integration.md', digest(body))
    expect(result).toMatchObject({
      pushed: false,
      phase: 'commit',
      reason: 'post-hook-mismatch',
    })
    expect(pushes).toBe(0)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(originHead)
    expect(await readFile(join(root, 'integration.md'), 'utf8')).toBe(body)
  })

  it('does not mistake a hook rewrite for Git normalization', async () => {
    const origin = await makeRemote()
    const root = await makeClone(origin, 'docs-hook-rewrite')
    await writeFile(join(root, 'integration.md'), 'requested')
    const repo = openRepo(root)
    const core = createCoreServices({
      active: () => ({
        remote: REMOTE,
        root,
        syncState: () => ({ kind: 'up-to-date' as const }),
        heldBack: () => [],
        deliverNow: async (_path, verify) => {
          await writeFile(join(root, 'integration.md'), 'rewritten')
          await repo.commitAll('Hook rewrite', ['integration.md'])
          if (!(await verify())) return false
          throw new Error('must not push a rewritten note')
        },
      }),
      reports: { get: () => ({ focusedPath: null, openPaths: [], recents: [] }) } as never,
      members: { get: async () => [] } as never,
    })(REMOTE, root)

    expect(await core.settle('integration.md', digest('requested'))).toMatchObject({
      pushed: false,
      phase: 'commit',
      reason: 'post-hook-mismatch',
    })
    expect(await plainGit(origin, ['cat-file', '-e', 'main:integration.md']).catch(() => '')).toBe(
      '',
    )
  })

  it('reports the delivered merge commit after a non-fast-forward recovery', async () => {
    const origin = await makeRemote()
    const root = await makeClone(origin, 'docs-recovery')
    const teammate = await makeClone(origin, 'docs-teammate')
    await writeFile(join(root, 'integration.md'), 'my note')
    await commitFile(teammate, 'teammate.md', 'their note')
    await plainGit(teammate, ['push', 'origin', 'HEAD:main'])
    let beforeMerge: string | null = null
    const core = realRepoServices(root, async (repo) => {
      beforeMerge = await repo.head()
      const rejected = await repo.push()
      expect(rejected.kind).toBe('rejected')
      expect((await repo.pull()).kind).toBe('merged')
      expect((await repo.push()).kind).toBe('pushed')
    })

    const result = await core.settle('integration.md', digest('my note'))
    expect(result).toMatchObject({ pushed: true, phase: 'complete', revision: digest('my note') })
    expect(result.commitSha).not.toBe(beforeMerge)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(result.commitSha)
    expect(await plainGit(origin, ['show', 'main:integration.md'])).toBe('my note')
    expect(await plainGit(origin, ['show', 'main:teammate.md'])).toBe('their note')
  })

  it('verifies the first push to an empty remote without an upstream', async () => {
    const origin = await makeEmptyRemote()
    const root = await makeClone(origin, 'docs-first-push')
    await writeFile(join(root, 'seed.md'), 'seed')
    await plainGit(root, ['add', 'seed.md'])
    await plainGit(root, ['commit', '-m', 'seed'])
    await plainGit(root, ['branch', '--unset-upstream'])
    await expect(plainGit(root, ['rev-parse', '@{upstream}'])).rejects.toThrow()
    await writeFile(join(root, 'first.md'), 'first')
    const repo = openRepo(root)
    const core = createCoreServices({
      active: () => ({
        remote: REMOTE,
        root,
        syncState: () => ({ kind: 'up-to-date' as const }),
        heldBack: () => [],
        deliverNow: async (_path, verify) => {
          await repo.commitAll('Add first note', ['first.md'])
          if (!(await verify())) return false
          await repo.push()
          return true
        },
      }),
      reports: { get: () => ({ focusedPath: null, openPaths: [], recents: [] }) } as never,
      members: { get: async () => [] } as never,
    })

    const result = await core(REMOTE, root).settle('first.md', digest('first'))
    expect(result).toMatchObject({ pushed: true, phase: 'complete' })
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(result.commitSha)
    // The push that published the branch also made it the upstream (`git.ts`).
    expect(await plainGit(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/main')
  })
})
