import { describe, expect, it } from 'vitest'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles } from './native-files-node'
import { createWorkingCopy, type NativeWorkingCopy } from '../app/working-copy'

function adapter(overrides: Partial<NativeWorkingCopy> = {}) {
  const calls: string[] = []
  const native: NativeWorkingCopy = {
    canonicalRoot: async (root) => root,
    identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
    candidates: async () => [],
    authorize: async (_root, path) => {
      calls.push(`authorize:${path}`)
      return true
    },
    recoveryPending: async () => false,
    status: async (_root, paths) => {
      calls.push(`status:${paths.join(',')}`)
      return paths.map((path) => ({ path, staged: false, worktree: true, conflict: false }))
    },
    ...overrides,
  }
  return { native, calls }
}

const vault = { remote: 'holi/vault', root: '/vault', branch: 'main' }

describe('working copy status', () => {
  it('filters local, secret, ignored and invalid candidates before authorization and status', async () => {
    const { native, calls } = adapter({
      candidates: async () => [
        ...['private.local.md', '.env', '.git/config', '../escape.md', 'notes.md'].map((path) => ({
          path,
          staged: false,
          worktree: true,
          conflict: false,
        })),
      ],
    })
    const result = await createWorkingCopy(native, vault).status()
    expect(result.changes.map(({ path }) => path)).toEqual(['notes.md'])
    expect(calls).toEqual(['authorize:notes.md', 'status:notes.md'])
  })

  it('refuses pending recovery and mismatched or detached identities before inspecting candidates', async () => {
    for (const override of [
      { recoveryPending: async () => true },
      { identity: async () => ({ remotes: ['holi/other'], branch: 'main', attached: true }) },
      { identity: async () => ({ remotes: ['holi/vault'], branch: 'other', attached: true }) },
      { identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: false }) },
    ]) {
      let inspected = false
      const { native } = adapter({
        ...override,
        candidates: async () => {
          inspected = true
          return []
        },
      })
      await expect(createWorkingCopy(native, vault).status()).rejects.toThrow()
      expect(inspected).toBe(false)
    }
  })

  it('serializes the same canonical root, recovers its queue after failure, and leaves other roots independent', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    const { native } = adapter({
      canonicalRoot: async (root) => root.replace('/alias', ''),
      candidates: async (root) => {
        entered++
        if (root === '/vault' && entered === 1) {
          await gate
          throw new Error('temporary failure')
        }
        return []
      },
    })
    const first = createWorkingCopy(native, vault).status()
    const second = createWorkingCopy(native, { ...vault, root: '/vault/alias' }).status()
    const other = createWorkingCopy(native, { ...vault, root: '/other' }).status()
    await other
    expect(entered).toBe(2)
    release()
    await expect(first).rejects.toThrow('temporary failure')
    await expect(second).resolves.toEqual({ changes: [] })
  })

  it('shares the storage lock across canonical root aliases and releases it after storage failure', async () => {
    const { mkdtemp, rm, mkdir, realpath } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp('/tmp/holi-working-copy-lock-')
    const aliasParent = await mkdtemp('/tmp/holi-working-copy-alias-')
    const alias = join(aliasParent, 'alias')
    await mkdir(alias)
    await rm(alias, { recursive: true })
    const { symlink } = await import('node:fs/promises')
    await symlink(root, alias)
    try {
      let release!: () => void
      let entered!: () => void
      const blocked = new Promise<void>((resolve) => (release = resolve))
      const publishing = new Promise<void>((resolve) => (entered = resolve))
      let failPublish = true
      const files = createNodeFiles()
      const nativeFiles = {
        ...files,
        async publish(...args: Parameters<typeof files.publish>) {
          entered()
          await blocked
          if (failPublish) throw new Error('injected save failure')
          return files.publish(...args)
        },
      }
      const storage = createVaultStorage(nativeFiles, { remote: 'holi/vault', root })
      const { native } = adapter({
        canonicalRoot: async (path) => (path === alias || path === root ? realpath(root) : path),
      })
      const initial = await storage.create('note.md', new TextEncoder().encode('before'))
      const saving = storage.save('note.md', new TextEncoder().encode('after'), initial.revision)
      await publishing
      const status = createWorkingCopy(native, { ...vault, root: alias }).status()
      await expect(
        createWorkingCopy(native, { ...vault, root: '/independent-root' }).status(),
      ).resolves.toEqual({ changes: [] })
      let statusFinished = false
      const waitingStatus = status.finally(() => (statusFinished = true))
      await Promise.resolve()
      expect(statusFinished).toBe(false)
      release()
      await expect(saving).rejects.toThrow('injected save failure')
      failPublish = false
      await expect(waitingStatus).resolves.toEqual({ changes: [] })
      expect((await storage.read('note.md')).bytes).toEqual(new TextEncoder().encode('before'))
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('rejects an invalid vault identity at construction', () => {
    const { native } = adapter()
    expect(() => createWorkingCopy(native, { ...vault, remote: 'not-a-remote' })).toThrow()
  })
})
