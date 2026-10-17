import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCoreServices } from '../src/main/capabilities/services'
import { VAULT_NAMESPACES, vaultCapabilities } from '../src/main/capabilities/vault-caps'
import type { SyncState } from '@holi/shared'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { scanVault } from '../src/main/vault/vault-store'
import { cleanupFixtures, makeClone, makeRemote, plainGit } from './helpers/git-fixtures'

const REMOTE = 'owner/repo'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
afterAll(cleanupFixtures)

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
      commitNow: async () => {
        await plainGit(root, ['add', '-A'])
        const changed = await plainGit(root, ['diff', '--cached', '--quiet']).then(
          () => false,
          () => true,
        )
        if (!changed) return null
        await plainGit(root, ['commit', '-m', 'CLI note mutation'])
        return plainGit(root, ['rev-parse', 'HEAD'])
      },
      pushNow: async () => {
        if (state.kind === 'offline' || state.kind === 'no-access')
          throw new Error('remote rejected')
        await plainGit(root, ['push', 'origin', 'HEAD:main'])
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
      claims: async () => [],
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

    const created = await receipt('docs.create', { path: 'integration.md', body: 'first' })
    expect(created.pushed).toBe(true)
    expect(await plainGit(origin, ['rev-parse', 'refs/heads/main'])).toBe(created.commitSha)
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
})
