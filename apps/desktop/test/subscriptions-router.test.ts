import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { rig, REMOTE } from './helpers/router-fixtures'
import { seedVault } from './helpers/seed'
import { createManagedCommitProvenance } from '../src/main/managed-commit-provenance'

const exec = promisify(execFile)

describe('subscriptions IPC', () => {
  async function realRepo(path = '') {
    const fixture = await rig()
    const { root, caller, host, session } = fixture
    if (path !== '') await mkdir(join(root, path), { recursive: true })
    await exec('git', ['init', '-b', 'main', root])
    await exec('git', ['-C', root, 'config', '--local', 'commit.gpgsign', 'false'])
    await exec('git', ['-C', root, 'config', '--local', 'tag.gpgsign', 'false'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    await exec('git', [
      '-C',
      root,
      'remote',
      'add',
      'origin',
      'https://github.com/syv-ai/1brain.git',
    ])
    await writeFile(join(root, 'seed.md'), 'seed\n', 'utf8')
    await gitCommit(root, ['seed.md'], 'seed')
    // Keep origin canonical for identity checks. A push-only local URL and a
    // local protocol policy prevent fixture lifecycle sync from reaching a network.
    const localRemote = join(fixture.base, 'query-origin.git')
    await exec('git', ['clone', '--bare', root, localRemote])
    await exec('git', ['-C', root, 'remote', 'set-url', '--push', 'origin', localRemote])
    expect((await exec('git', ['-C', root, 'remote', 'get-url', 'origin'])).stdout.trim()).toBe(
      'https://github.com/syv-ai/1brain.git',
    )
    expect(
      (await exec('git', ['-C', root, 'remote', 'get-url', '--push', 'origin'])).stdout.trim(),
    ).toBe(localRemote)
    await exec('git', ['-C', root, 'config', '--local', 'protocol.https.allow', 'never'])
    await caller.vaults.open({ remote: REMOTE })
    const active = host.active()!
    // Own the fixture's Git history: long timer intervals do not stop startup
    // sync that was already admitted while opening the vault.
    active.pause('subscription history fixture')
    await active.drainSync()
    // Subscription query fixtures have immutable commit history. Never permit
    // host lifecycle sync to contact any transport, even the local mirror.
    active.repo.push = vi.fn(async () => ({ kind: 'nothing-to-push' as const }))
    active.repo.pull = vi.fn(async () => ({ kind: 'up-to-date' as const }))
    active.repo.fetch = vi.fn(async () => {})
    await caller.subscriptions.set({ remote: REMOTE, path, enabled: true })
    return { ...fixture, active, session }
  }

  async function gitCommit(root: string, paths: string[], message: string, author?: string) {
    await exec('git', ['-C', root, 'add', '-f', '--', ...paths])
    await exec('git', [
      '-C',
      root,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...(author
        ? ['-c', `user.name=${author}`, '-c', `user.email=${author}@example.invalid`]
        : []),
      'commit',
      '-m',
      message,
    ])
    return (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
  }

  async function addFile(root: string, path: string, text = `${path}\n`) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text, 'utf8')
  }

  it('returns exact explicit-scope history with conservative ownership through IPC', async () => {
    const { caller, host } = await realRepo()
    const active = host.active()!
    const sha = 'a'.repeat(40)
    active.repo.revisionChanges = vi.fn(async () => ({
      complete: true,
      reason: 'ok' as const,
      changes: [{ sha, path: 'note.md' }],
    }))

    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline: expect.any(String),
        complete: true,
        history: 'ok',
        changes: [{ sha, path: 'note.md', ownership: 'unknown', reviewed: false }],
      },
    )
    expect(active.repo.revisionChanges).toHaveBeenCalledOnce()
  })
  it('suppresses an exact commit recorded by the managed provenance recorder', async () => {
    const { caller, host, userData, session } = await realRepo()
    const active = host.active()!
    const baseline = await active.repo.head()
    const recorder = createManagedCommitProvenance({
      file: join(userData, 'managed-commit-provenance.json'),
      remote: REMOTE,
      identity: () => ({ accountId: 42, generation: 0 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const managedTicket = await recorder.begin(active.root)
    await exec('git', ['-C', active.root, 'config', 'user.name', 'Test'])
    await exec('git', ['-C', active.root, 'config', 'user.email', 'test@example.invalid'])
    await writeFile(join(active.root, 'owned.md'), 'owned\n', 'utf8')
    await exec('git', ['-C', active.root, 'add', 'owned.md'])
    await exec('git', ['-C', active.root, 'commit', '-m', 'managed'])
    const sha = await active.repo.head()
    // This proves the recorder's durable exact identity is consumed by the
    // registered caller procedure after a process-style restart.
    await recorder.record(managedTicket, active.root, sha)
    expect(await readFile(join(userData, 'managed-commit-provenance.json'), 'utf8')).toContain(sha)
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline,
        tip: await active.repo.head(),
        complete: true,
        history: 'ok',
        changes: [],
      },
    )
  })

  it('suppresses only a recorded commit, regardless of matching or changed authorship', async () => {
    const { caller, active, userData, session } = await realRepo()
    const recorder = createManagedCommitProvenance({
      file: join(userData, 'managed-commit-provenance.json'),
      remote: REMOTE,
      identity: () => ({ accountId: 42, generation: 0 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    await addFile(active.root, 'same.md', 'managed\n')
    const ticket = await recorder.begin(active.root)
    const ownSha = await gitCommit(active.root, ['same.md'], 'managed')
    await recorder.record(ticket, active.root, ownSha)
    await addFile(active.root, 'same.md', 'manual same author\n')
    const sameAuthorSha = await gitCommit(active.root, ['same.md'], 'manual same author')
    await addFile(active.root, 'same.md', 'manual other author\n')
    const otherAuthorSha = await gitCommit(active.root, ['same.md'], 'manual other author', 'Agent')
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })

    const result = await caller.subscriptions.changes({ remote: REMOTE, path: '' })
    expect(result.changes.map(({ sha }) => sha)).toEqual([otherAuthorSha, sameAuthorSha])
    expect(result.changes).toEqual([
      { sha: otherAuthorSha, path: 'same.md', ownership: 'unknown', reviewed: false },
      { sha: sameAuthorSha, path: 'same.md', ownership: 'unknown', reviewed: false },
    ])
  })

  it('keeps ownership tied to repository lifetime and account, not auth generation', async () => {
    const { caller, active, userData, session } = await realRepo()
    const baseline = await active.repo.head()
    const recorder = createManagedCommitProvenance({
      file: join(userData, 'managed-commit-provenance.json'),
      remote: REMOTE,
      identity: () => ({ accountId: 42, generation: 2 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const ticket = await recorder.begin(active.root)
    await addFile(active.root, 'owned.md')
    const sha = await gitCommit(active.root, ['owned.md'], 'managed')
    await recorder.record(ticket, active.root, sha)
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline,
        tip: await active.repo.head(),
        complete: true,
        history: 'ok',
        changes: [],
      },
    )
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 43 } })
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        changes: [{ sha, path: 'owned.md', ownership: 'unknown', reviewed: false }],
      },
    )
  })

  it('retains unknown branch commits but suppresses the exact recorded merge', async () => {
    const { caller, active, userData, session } = await realRepo()
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    const recorder = createManagedCommitProvenance({
      file: join(userData, 'managed-commit-provenance.json'),
      remote: REMOTE,
      identity: () => ({ accountId: 42, generation: 0 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const base = await active.repo.head()
    await exec('git', ['-C', active.root, 'checkout', '-b', 'side'])
    await addFile(active.root, 'branch.md')
    const branch = await gitCommit(active.root, ['branch.md'], 'branch')
    await exec('git', ['-C', active.root, 'checkout', 'main'])
    await addFile(active.root, 'main.md')
    const mainCommit = await gitCommit(active.root, ['main.md'], 'main')
    const ticket = await recorder.begin(active.root)
    await exec('git', [
      '-C',
      active.root,
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--no-ff',
      'side',
      '-m',
      'merge',
    ])
    const merge = await active.repo.head()
    await recorder.record(ticket, active.root, merge!)
    const result = await caller.subscriptions.changes({ remote: REMOTE, path: '' })
    expect(result).toMatchObject({ baseline: base, complete: true, history: 'ok' })
    expect(result.changes.map(({ sha }) => sha)).toHaveLength(2)
    expect(result.changes.map(({ sha }) => sha)).toEqual(
      expect.arrayContaining([mainCommit, branch]),
    )
    expect(result.changes.map(({ sha }) => sha)).not.toContain(merge)
  })

  it('reports null and missing baselines as explicitly incomplete', async () => {
    const { caller, active, userData } = await realRepo()
    const scopeFile = join(userData, 'subscriptions.json')
    const saved = JSON.parse(await readFile(scopeFile, 'utf8'))
    saved.remotes[REMOTE][0].baseline = null
    await writeFile(scopeFile, JSON.stringify(saved), 'utf8')
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline: null,
        tip: null,
        complete: false,
        history: 'pending-baseline',
        changes: [],
      },
    )
    saved.remotes[REMOTE][0].baseline = '0'.repeat(40)
    await writeFile(scopeFile, JSON.stringify(saved), 'utf8')
    const missing = await caller.subscriptions.changes({ remote: REMOTE, path: '' })
    expect(missing).toMatchObject({ complete: false, history: 'history-unavailable', changes: [] })
    expect(missing.tip).toBe(await active.repo.head())
    saved.remotes[REMOTE][0].baseline = await active.repo.head()
    await writeFile(scopeFile, JSON.stringify(saved), 'utf8')
    await exec('git', ['-C', active.root, 'checkout', '--orphan', 'rewritten'])
    await exec('git', ['-C', active.root, 'rm', '-rf', '.'])
    await addFile(active.root, 'rewritten.md')
    await gitCommit(active.root, ['rewritten.md'], 'rewritten root')
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        complete: false,
        history: 'history-unavailable',
        changes: [],
      },
    )
  })

  it('rejects a query whose subscription is removed during real traversal', async () => {
    const { caller, active } = await realRepo()
    await addFile(active.root, 'race.md')
    await gitCommit(active.root, ['race.md'], 'race')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    const original = active.repo.revisionChanges.bind(active.repo)
    active.repo.revisionChanges = vi.fn(async (...args) => {
      entered()
      await gate
      return original(...args)
    })
    try {
      const query = caller.subscriptions.changes({ remote: REMOTE, path: '' })
      await started
      await caller.subscriptions.set({ remote: REMOTE, path: '', enabled: false })
      release()
      await expect(query).resolves.toMatchObject({
        complete: false,
        history: 'unavailable',
        changes: [],
      })
      expect(active.repo.revisionChanges).toHaveBeenCalledOnce()
    } finally {
      release()
    }
  })

  it.each([
    [
      'the signed-in account changes',
      async ({ session }: Awaited<ReturnType<typeof realRepo>>) => {
        Object.defineProperty(session, 'viewer', {
          configurable: true,
          value: { accountId: 42 },
        })
      },
    ],
    [
      'the auth generation changes for the same account',
      async ({ session }: Awaited<ReturnType<typeof realRepo>>) => {
        const generation = session.generation
        vi.spyOn(session, 'generation', 'get').mockReturnValue(generation + 1)
      },
    ],
    [
      'the active runtime changes',
      async ({ host }: Awaited<ReturnType<typeof realRepo>>) => {
        vi.spyOn(host, 'active').mockReturnValue(null)
      },
    ],
    [
      'the origin remote changes',
      async ({ active }: Awaited<ReturnType<typeof realRepo>>) => {
        await exec('git', [
          '-C',
          active.root,
          'remote',
          'set-url',
          'origin',
          'https://github.com/other/repo.git',
        ])
      },
    ],
    [
      'the repository lifetime marker changes',
      async ({ active }: Awaited<ReturnType<typeof realRepo>>) => {
        const marker = join(active.root, '.git', 'holi-managed-provenance-id')
        await writeFile(marker, 'replacement-lifetime\n', 'utf8')
      },
    ],
    [
      'the saved baseline changes',
      async ({ userData }: Awaited<ReturnType<typeof realRepo>>) => {
        const file = join(userData, 'subscriptions.json')
        const saved = JSON.parse(await readFile(file, 'utf8'))
        saved.remotes[REMOTE][0].baseline = 'f'.repeat(40)
        await writeFile(file, JSON.stringify(saved), 'utf8')
      },
    ],
  ])('rejects real history when %s during traversal', async (_context, invalidate) => {
    const fixture = await realRepo()
    const { caller, active } = fixture
    await writeFile(
      join(active.root, '.git', 'holi-managed-provenance-id'),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n',
      'utf8',
    )
    await addFile(active.root, 'context-race.md')
    await gitCommit(active.root, ['context-race.md'], 'context race')
    const original = active.repo.revisionChanges.bind(active.repo)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    active.repo.revisionChanges = vi.fn(async (...args) => {
      entered()
      await gate
      return original(...args)
    })

    try {
      const query = caller.subscriptions.changes({ remote: REMOTE, path: '' })
      await started
      await invalidate(fixture)
      release()
      await expect(query).resolves.toMatchObject({
        complete: false,
        history: 'unavailable',
        changes: [],
      })
      expect(active.repo.revisionChanges).toHaveBeenCalledOnce()
    } finally {
      release()
    }
  })

  it('does not let provenance from another root suppress the same commit OID', async () => {
    const first = await realRepo()
    const second = await realRepo()
    const lifetime = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc\n'
    for (const active of [first.active, second.active])
      await writeFile(join(active.root, '.git', 'holi-managed-provenance-id'), lifetime, 'utf8')
    await addFile(first.active.root, 'shared.md')
    const sha = await gitCommit(first.active.root, ['shared.md'], 'shared history')
    const baseline = await exec('git', ['-C', first.active.root, 'rev-parse', `${sha}^`])
    await exec('git', ['-C', second.active.root, 'fetch', first.active.root, sha])
    await exec('git', ['-C', second.active.root, 'checkout', '--detach', sha])
    const secondScope = join(second.userData, 'subscriptions.json')
    const saved = JSON.parse(await readFile(secondScope, 'utf8'))
    saved.remotes[REMOTE][0].baseline = baseline.stdout.trim()
    await writeFile(secondScope, JSON.stringify(saved), 'utf8')

    const recorder = createManagedCommitProvenance({
      file: join(first.userData, 'managed-commit-provenance.json'),
      remote: REMOTE,
      identity: () => ({ accountId: 42, generation: 0 }),
      subscribed: async () => true,
      subscribedNow: () => true,
    })
    const ticket = await recorder.begin(first.active.root)
    await recorder.record(ticket, first.active.root, sha)
    await writeFile(
      join(second.userData, 'managed-commit-provenance.json'),
      await readFile(join(first.userData, 'managed-commit-provenance.json'), 'utf8'),
      'utf8',
    )
    for (const session of [first.session, second.session])
      Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })

    await expect(
      second.caller.subscriptions.changes({ remote: REMOTE, path: '' }),
    ).resolves.toMatchObject({
      complete: true,
      changes: [{ sha, path: 'shared.md', ownership: 'unknown', reviewed: false }],
    })
  })

  it('keeps the captured HEAD when HEAD advances during real traversal', async () => {
    const { caller, active } = await realRepo()
    await addFile(active.root, 'captured-tip.md')
    const capturedTip = await gitCommit(active.root, ['captured-tip.md'], 'captured tip')
    const original = active.repo.revisionChanges.bind(active.repo)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const started = new Promise<void>((resolve) => (entered = resolve))
    active.repo.revisionChanges = vi.fn(async (...args) => {
      entered()
      await gate
      return original(...args)
    })

    try {
      const query = caller.subscriptions.changes({ remote: REMOTE, path: '' })
      await started
      await addFile(active.root, 'later.md')
      await gitCommit(active.root, ['later.md'], 'later tip')
      release()
      await expect(query).resolves.toMatchObject({
        tip: capturedTip,
        complete: true,
        history: 'ok',
      })
      expect(active.repo.revisionChanges).toHaveBeenCalledOnce()
    } finally {
      release()
    }
  })

  it('reports a true unborn HEAD as a pending baseline', async () => {
    const { caller, active } = await realRepo()
    // Host setup seeds an initial commit. Removing only the branch ref leaves
    // HEAD symbolic but genuinely unborn, while preserving all stored objects.
    await exec('git', ['-C', active.root, 'update-ref', '-d', 'refs/heads/main'])
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline: expect.any(String),
        tip: null,
        complete: false,
        history: 'pending-baseline',
        changes: [],
      },
    )
  })

  it('returns a pending baseline when the subscription has none', async () => {
    const { caller, userData } = await realRepo()
    const scopeFile = join(userData, 'subscriptions.json')
    const saved = JSON.parse(await readFile(scopeFile, 'utf8'))
    saved.remotes[REMOTE][0].baseline = null
    await writeFile(scopeFile, JSON.stringify(saved), 'utf8')
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        baseline: null,
        tip: null,
        complete: false,
        history: 'pending-baseline',
        changes: [],
      },
    )
  })

  it('keeps overlapping scopes on their independently captured baselines', async () => {
    const { caller, active } = await realRepo('folder')
    await addFile(active.root, 'folder/first.md')
    const first = await gitCommit(active.root, ['folder/first.md'], 'first')
    await caller.subscriptions.set({ remote: REMOTE, path: 'folder/first.md', enabled: true })
    const later = await active.repo.head()
    await addFile(active.root, 'folder/second.md')
    const second = await gitCommit(active.root, ['folder/second.md'], 'second')
    const folder = await caller.subscriptions.changes({ remote: REMOTE, path: 'folder' })
    const file = await caller.subscriptions.changes({ remote: REMOTE, path: 'folder/first.md' })
    expect(folder.baseline).not.toBe(later)
    expect(folder.changes.map(({ sha }) => sha)).toContain(second)
    expect(file.baseline).toBe(later)
    expect(file.changes).toEqual([])
    expect(first).not.toBe(second)
  })

  it('includes deleted, renamed and literal wildcard-character paths', async () => {
    const { caller, active } = await realRepo()
    await addFile(active.root, 'gone.md')
    await addFile(active.root, 'old.md')
    await addFile(active.root, 'literal[?].md')
    await gitCommit(active.root, ['gone.md', 'old.md', 'literal[?].md'], 'add paths')
    await caller.subscriptions.set({ remote: REMOTE, path: 'literal[?].md', enabled: true })
    await exec('git', ['-C', active.root, 'rm', 'gone.md', 'old.md'])
    await addFile(active.root, 'new.md')
    const changed = await gitCommit(active.root, ['new.md'], 'rename and delete')
    await exec('git', ['-C', active.root, 'mv', 'new.md', 'old.md'])
    await addFile(active.root, 'literal[?].md', 'changed\n')
    const renamed = await gitCommit(active.root, ['old.md', 'literal[?].md'], 'rename and literal')
    const result = await caller.subscriptions.changes({ remote: REMOTE, path: '' })
    expect(result).toMatchObject({ complete: true, history: 'ok' })
    expect(result.changes.map(({ sha, path }) => [sha, path])).toContainEqual([changed, 'gone.md'])
    expect(result.changes.map(({ sha, path }) => [sha, path])).toContainEqual([renamed, 'old.md'])
    expect(result.changes.map(({ sha, path }) => [sha, path])).toContainEqual([
      renamed,
      'literal[?].md',
    ])
    const literal = await caller.subscriptions.changes({ remote: REMOTE, path: 'literal[?].md' })
    expect(literal.changes).toEqual([
      { sha: renamed, path: 'literal[?].md', ownership: 'unknown', reviewed: false },
    ])
  })

  it('fences secret, local, ignored and current symlink history paths', async () => {
    const { caller, active, base } = await realRepo()
    await exec('git', ['-C', active.root, 'config', 'core.excludesFile', '/dev/null'])
    await writeFile(join(active.root, '.gitignore'), 'node_modules/\n', 'utf8')
    const outside = join(base, 'outside')
    await mkdir(outside)
    await symlink(outside, join(active.root, 'outside-link'))
    await mkdir(join(active.root, 'swapped'), { recursive: true })
    for (const path of [
      'safe.md',
      'USER.local.md',
      '.env.token',
      'node_modules/ignored.md',
      '.DS_Store',
      'Thumbs.db',
      '.holi-tmp-note.md',
      'swapped/historical.md',
    ])
      await addFile(active.root, path)
    await gitCommit(
      active.root,
      [
        '.gitignore',
        'safe.md',
        'USER.local.md',
        '.env.token',
        'node_modules/ignored.md',
        '.DS_Store',
        'Thumbs.db',
        '.holi-tmp-note.md',
        'swapped/historical.md',
      ],
      'fenced',
    )
    await exec('git', ['-C', active.root, 'add', '-f', 'outside-link'])
    await exec('git', [
      '-C',
      active.root,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'symlink',
    ])
    // The path was ordinary content when committed; replacing its ancestor
    // with a symlink before the query must still fence its old history.
    await rm(join(active.root, 'swapped'), { recursive: true })
    await symlink(outside, join(active.root, 'swapped'))
    const result = await caller.subscriptions.changes({ remote: REMOTE, path: '' })
    expect(result.changes.map(({ path }) => path)).toContain('safe.md')
    for (const path of [
      'USER.local.md',
      '.env.token',
      'node_modules/ignored.md',
      '.DS_Store',
      'Thumbs.db',
      '.holi-tmp-note.md',
      'swapped/historical.md',
      'outside-link',
    ])
      expect(result.changes.map(({ path }) => path)).not.toContain(path)
  })

  it('does not create provenance or mutate subscription state when records are absent', async () => {
    const { caller, active, userData, session } = await realRepo()
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    await addFile(active.root, 'unknown.md')
    const sha = await gitCommit(active.root, ['unknown.md'], 'manual')
    const scopeFile = join(userData, 'subscriptions.json')
    const before = await readFile(scopeFile, 'utf8')
    const lifetime = join(active.root, '.git', 'holi-managed-provenance-id')
    const provenance = join(userData, 'managed-commit-provenance.json')
    expect(await readFile(lifetime, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(provenance, 'utf8').catch(() => null)).toBeNull()
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        complete: true,
        history: 'ok',
        changes: [{ sha, ownership: 'unknown', reviewed: false }],
      },
    )
    expect(await readFile(scopeFile, 'utf8')).toBe(before)
    expect(await readFile(lifetime, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(provenance, 'utf8').catch(() => null)).toBeNull()
  })

  it('reads a corrupt provenance record as unknown for a valid lifetime and account', async () => {
    const { caller, active, userData, session } = await realRepo()
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    const lifetime = join(active.root, '.git', 'holi-managed-provenance-id')
    const validLifetime = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd\n'
    await writeFile(lifetime, validLifetime, 'utf8')
    await addFile(active.root, 'unknown.md')
    const sha = await gitCommit(active.root, ['unknown.md'], 'manual')
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'managed-commit-provenance.json'), '{broken', 'utf8')
    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        complete: true,
        history: 'ok',
        changes: [{ sha, ownership: 'unknown', reviewed: false }],
      },
    )
  })

  it('treats a malformed lifetime marker as unavailable ownership without repairing it', async () => {
    const { caller, active, session } = await realRepo()
    Object.defineProperty(session, 'viewer', { configurable: true, value: { accountId: 42 } })
    await addFile(active.root, 'manual.md')
    const sha = await gitCommit(active.root, ['manual.md'], 'manual')
    const marker = join(active.root, '.git', 'holi-managed-provenance-id')
    await writeFile(marker, 'not-a-uuid\n', 'utf8')

    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        complete: true,
        changes: [{ sha, path: 'manual.md', ownership: 'unknown', reviewed: false }],
      },
    )
    expect(await readFile(marker, 'utf8')).toBe('not-a-uuid\n')
  })

  it('accepts a case-preserved canonical GitHub origin through the registered caller', async () => {
    const { caller, active } = await realRepo()
    await addFile(active.root, 'case.md')
    const sha = await gitCommit(active.root, ['case.md'], 'case')
    await exec('git', [
      '-C',
      active.root,
      'remote',
      'set-url',
      'origin',
      'https://github.com/Syv-AI/1Brain.git',
    ])

    await expect(caller.subscriptions.changes({ remote: REMOTE, path: '' })).resolves.toMatchObject(
      {
        complete: true,
        history: 'ok',
        changes: expect.arrayContaining([expect.objectContaining({ sha, path: 'case.md' })]),
      },
    )
  })

  it('captures the active repository and userData before awaiting HEAD', async () => {
    const { caller, host, registry, base, userData, root } = await rig()
    // This fixture also opens a real host. Keep its canonical origin but route
    // any startup transport to a disposable local bare repository.
    await exec('git', ['init', '-b', 'main', root])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    await exec('git', [
      '-C',
      root,
      'remote',
      'add',
      'origin',
      'https://github.com/syv-ai/1brain.git',
    ])
    await exec('git', ['-C', root, 'add', '-A'])
    await exec('git', [
      '-C',
      root,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'seed',
    ])
    const localRemote = join(base, 'capture-origin.git')
    await exec('git', ['clone', '--bare', root, localRemote])
    await exec('git', ['-C', root, 'remote', 'set-url', '--push', 'origin', localRemote])
    await exec('git', ['-C', root, 'config', '--local', 'protocol.https.allow', 'never'])
    await caller.vaults.open({ remote: REMOTE })
    const activeA = host.active()!
    activeA.repo.push = vi.fn(async () => ({ kind: 'nothing-to-push' as const }))
    activeA.repo.pull = vi.fn(async () => ({ kind: 'up-to-date' as const }))
    activeA.repo.fetch = vi.fn(async () => {})
    let release!: (sha: string) => void
    const delayed = new Promise<string>((resolve) => (release = resolve))
    const capturedHead = vi.fn(() => delayed)
    activeA.repo.head = capturedHead

    const setting = caller.subscriptions.set({ remote: REMOTE, path: '', enabled: true })
    await vi.waitFor(() => expect(capturedHead).toHaveBeenCalledOnce())

    const betaRoot = join(base, 'beta-subscriptions')
    await mkdir(betaRoot, { recursive: true })
    await seedVault(betaRoot)
    await exec('git', ['init', '-b', 'main', betaRoot])
    await exec('git', ['-C', betaRoot, 'config', 'user.name', 'Test'])
    await exec('git', ['-C', betaRoot, 'config', 'user.email', 'test@example.invalid'])
    await exec('git', [
      '-C',
      betaRoot,
      'remote',
      'add',
      'origin',
      'https://github.com/syv-ai/beta-subscriptions.git',
    ])
    await exec('git', ['-C', betaRoot, 'add', '-A'])
    await exec('git', [
      '-C',
      betaRoot,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'seed',
    ])
    const betaRemote = join(base, 'beta-origin.git')
    await exec('git', ['clone', '--bare', betaRoot, betaRemote])
    await exec('git', ['-C', betaRoot, 'remote', 'set-url', '--push', 'origin', betaRemote])
    await exec('git', ['-C', betaRoot, 'config', '--local', 'protocol.https.allow', 'never'])
    await registry.add({
      remote: 'syv-ai/beta-subscriptions',
      path: betaRoot,
      name: 'beta-subscriptions',
      lastOpenedAt: '2026-07-01T00:00:00Z',
    })
    await caller.vaults.open({ remote: 'syv-ai/beta-subscriptions' })
    const activeB = host.active()!
    activeB.repo.push = vi.fn(async () => ({ kind: 'nothing-to-push' as const }))
    activeB.repo.pull = vi.fn(async () => ({ kind: 'up-to-date' as const }))
    activeB.repo.fetch = vi.fn(async () => {})
    release('a'.repeat(40))
    await setting

    const persisted = JSON.parse(await readFile(join(userData, 'subscriptions.json'), 'utf8')) as {
      remotes: Record<string, { path: string; baseline: string | null }[]>
    }
    expect(persisted.remotes[REMOTE]).toEqual([{ path: '', baseline: 'a'.repeat(40) }])
    expect(persisted.remotes).not.toHaveProperty('syv-ai/beta-subscriptions')
    expect(host.active()?.remote).toBe('syv-ai/beta-subscriptions')
  })

  it('rejects a wrong active remote and validates set inputs through the caller', async () => {
    const { caller } = await rig()
    await caller.vaults.open({ remote: REMOTE })
    await expect(
      caller.subscriptions.set({ remote: 'other/repo', path: '', enabled: true }),
    ).rejects.toThrow(/vault changed/)
    await expect(
      caller.subscriptions.set({ remote: REMOTE, path: '../escape', enabled: true }),
    ).rejects.toThrow()
    await expect(caller.subscriptions.list({ remote: REMOTE, paths: '{invalid' })).rejects.toThrow(
      /invalid subscription paths/i,
    )
  })
})
