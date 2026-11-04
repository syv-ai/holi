import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile as readText,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import type { CapabilityError } from '../src/main/capabilities/error'
import {
  cap,
  createCapabilityRegistry,
  type CapabilityContext,
} from '../src/main/capabilities/registry'
import { admitApps, type AppGrants } from '../src/plugins/apps/main/grants'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { noCoreServices, type CoreServices } from '../src/main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../src/main/capabilities/vault-caps'
import { SCREENSHOT_DIR } from '../src/main/screenshot-files'
import type { GoogleAccountsManager } from '../src/plugins/google/main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../src/plugins/google/main/capabilities'
import { taskCapabilities, TASKS_NAMESPACES } from '../src/plugins/tasks/main/capabilities'
import { parseTaskFile, taskClaim } from '@holi/shared'
import { MEMBERS_TTL_MS, createMembersCache } from '../src/main/github/members-cache'
import { withFileLock } from '../src/main/vault/vault-files'

const registry = createCapabilityRegistry()
/** What `docs.open` asked to show, by vault path. */
const opened: string[] = []
registry.register(
  VAULT_NAMESPACES,
  vaultCapabilities({
    updateSkills: async () => ({ summary: '', conflicts: null }),
    pendingSkills: async () => [],
    open: (_remote, path) => void opened.push(path),
    screenshot: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  }),
)
registry.register(TASKS_NAMESPACES, taskCapabilities({ today: () => '2026-09-30' }))
/** What the Google entries see of this person's approvals; each test sets it. */
let grantStatus: AppGrants['status'] = async () => ({ codeHash: '', affordances: [] })
registry.register(
  GOOGLE_NAMESPACES,
  googleCapabilities({
    accounts: {} as GoogleAccountsManager,
    dataFor: async () => null,
    calendarPrefs: { read: async () => ({}), set: async () => {} },
    imagePrefs: { read: async () => [], allow: async () => {}, clear: async () => {} },
  }),
)
/** The app door's consent check, as the vault apps code opens it. */
const admit = admitApps({ status: (...args) => grantStatus(...args), grant: async () => true })
const runCapability = registry.run

describe('the capability registry', () => {
  const ping = cap({
    doors: ['cli'],
    cli: { args: [], summary: 'ping' },
    params: () => ({}),
    run: async () => 'pong',
  })

  it('gives a namespace one owner, and keeps a name inside its owner', () => {
    const caps = createCapabilityRegistry()
    const undo = caps.register(['x'], { 'x.ping': ping })
    expect(caps.has('x.ping')).toBe(true)
    expect(() => caps.register(['x'], { 'x.pong': ping })).toThrow(/already registered/)
    expect(() => caps.register(['y'], { 'z.ping': ping })).toThrow(/outside/)
    undo()
    expect(caps.has('x.ping')).toBe(false)
    caps.register(['x'], { 'x.pong': ping })
  })

  it('opens an entry only at the doors it names', async () => {
    const caps = createCapabilityRegistry()
    caps.register(['x'], { 'x.ping': ping })
    const ctx = {} as CapabilityContext
    expect((await caps.run('x.ping', 'cli', ctx, {})).value).toBe('pong')
    await expect(caps.run('x.ping', 'app', ctx, {})).rejects.toThrow(/no such method/)
  })
})

describe('the capability host', () => {
  const host = (pluginEnabled: (plugin: string) => boolean) => {
    const caps = createCapabilityRegistry()
    const ui = cap({ doors: ['ui'], params: () => null, run: async () => 'ok' })
    caps.register(['core'], { 'core.ping': ui })
    caps.register(
      ['fake'],
      { 'fake.ping': ui, 'fake.cli': { ...ui, doors: ['cli'], cli: { args: [], summary: '' } } },
      'fake',
    )
    return createCapabilityHost({
      registry: caps,
      rootFor: async () => '/vault',
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async (plugin) => pluginEnabled(plugin),
      claims: async () => [],
    })
  }

  it("names a door's entries, leaving out those of plugins the vault has off", async () => {
    expect(await host(() => true).names('o/r', 'ui')).toEqual(['core.ping', 'fake.ping'])
    expect(await host(() => false).names('o/r', 'ui')).toEqual(['core.ping'])
  })

  it('serializes CLI note mutations and their settlement', async () => {
    let calls = 0
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const caps = createCapabilityRegistry()
    caps.register(['docs'], {
      'docs.inspect': cap({
        doors: ['cli'],
        cli: { args: [], summary: 'read' },
        params: () => ({}),
        run: async () => 'inspected',
      }),
      'docs.update': cap({
        doors: ['cli'],
        cli: { args: [], summary: 'test' },
        params: () => ({}),
        run: async () => {
          calls++
          if (calls === 1) await first
          return calls
        },
      }),
    })
    const h = createCapabilityHost({
      registry: caps,
      rootFor: async () => '/vault',
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const call = () => h.dispatch({ door: 'cli', remote: 'o/r', name: 'docs.update', params: {} })
    const one = call()
    const two = call()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toBe(1)
    // A read-only inspection is not held behind a write's settlement.
    expect(
      (await h.dispatch({ door: 'cli', remote: 'o/r', name: 'docs.inspect', params: {} })).value,
    ).toBe('inspected')
    release()
    expect((await one).value).toBe(1)
    expect((await two).value).toBe(2)
  })

  it('opens the app door once', () => {
    const h = host(() => true)
    h.openAppDoor({ admit: async () => {} })
    expect(() => h.openAppDoor({ admit: async () => {} })).toThrow(/already open/)
  })

  it("asks the opener's consent for an entry with an appGrant, at the app door only", async () => {
    const caps = createCapabilityRegistry()
    caps.register(['x'], {
      'x.read': cap({
        doors: ['app', 'ui'],
        appGrant: 'mail',
        params: () => null,
        run: async () => 'mail',
      }),
    })
    const h = createCapabilityHost({
      registry: caps,
      rootFor: async () => '/vault',
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const asked: string[] = []
    const door = h.openAppDoor({
      admit: async (_ctx, grant) => {
        asked.push(grant)
        throw new Error('not approved')
      },
    })
    await expect(door.call('o/r', 'A.app', 'x.read', {})).rejects.toThrow(/not approved/)
    expect(asked).toEqual(['mail'])
    expect(
      (await h.dispatch({ door: 'ui', remote: 'o/r', name: 'x.read', params: {} })).value,
    ).toBe('mail')
    // Without a consent check, the registry refuses rather than skipping it.
    await expect(caps.run('x.read', 'app', {} as CapabilityContext, {})).rejects.toThrow(
      /no such method/,
    )
  })
})

// ---- The reads and acts past the vault's files, through a fake services ----

let root: string
/** What the fake snapshot lists: every file `put` wrote, as the scanner would. */
let written: string[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-caps-'))
  written = []
})

async function put(rel: string, text: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), text)
  written.push(rel)
}

function ctx(core: Partial<CoreServices>, bundle: string | null = 'A.app'): CapabilityContext {
  return {
    remote: 'o/r',
    root,
    bundle,
    snapshot: async () => ({
      ...emptyVaultSnapshot(),
      files: written.map((path) => ({ path, updatedAt: '' })),
      docs: written.filter((path) => path.endsWith('.md')).map((path) => ({ path, updatedAt: '' })),
      dirs: written.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))),
    }),
    // The tasks plugin runs: a note write to a task file asks its claim.
    claims: async () => [taskClaim],
    // Holi has this vault open unless a test says otherwise (`requireOpen`).
    core: { ...noCoreServices(), syncState: () => ({ kind: 'up-to-date' }), ...core },
  }
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: CapabilityError) => ({ code: e.code, message: e.message }),
  )

describe('vault.recents', () => {
  it('keeps what an app may name, never the agent surface', async () => {
    const recents = () => [
      { kind: 'path' as const, key: 'a.md' },
      { kind: 'path' as const, key: '.holi/memory/x.md' },
      { kind: 'terminal' as const, key: 't1' },
      { kind: 'command' as const, key: 'board.open' },
      { kind: 'surface' as const, key: 'board' },
      { kind: 'surface' as const, key: 'app', id: 'B.app' },
      { kind: 'surface' as const, key: 'app', id: '.holi/memory/x.app' },
    ]
    const { value } = await runCapability('vault.recents', 'app', ctx({ recents }), undefined)
    expect(value).toEqual([
      { kind: 'path', key: 'a.md' },
      { kind: 'surface', key: 'board' },
      { kind: 'surface', key: 'app', id: 'B.app' },
    ])
  })

  it('reaches the agent too, one per line', async () => {
    const recents = () => [{ kind: 'path' as const, key: 'a.md' }]
    const { text } = await runCapability('vault.recents', 'cli', ctx({ recents }, null), {})
    expect(text).toBe('path\ta.md')
  })
})

describe('sync.status', () => {
  it('says "not open" for a vault main does not track', async () => {
    const { value, text } = await runCapability(
      'sync.status',
      'cli',
      ctx({ syncState: () => null }, null),
      {},
    )
    expect(value).toBeNull()
    expect(text).toBe('not open')
  })
})

describe('vault.members', () => {
  it('gives logins and avatars only', async () => {
    const members = async () => [
      { accountId: 1, login: 'ada', avatarUrl: 'https://x/a.png', permission: 'admin' },
    ]
    const { value } = await runCapability(
      'vault.members',
      'app',
      ctx({ members } as Partial<CoreServices>),
      {},
    )
    expect(value).toEqual([{ login: 'ada', avatarUrl: 'https://x/a.png' }])
  })

  it('turns a GitHub failure into UNAVAILABLE', async () => {
    const members = async () => {
      throw new Error('rate limited')
    }
    expect(await refusal(runCapability('vault.members', 'app', ctx({ members }), {}))).toEqual({
      code: 'UNAVAILABLE',
      message: 'rate limited',
    })
  })

  it('asks GitHub once per TTL, and again after a failure or a forget', async () => {
    let clock = 0
    const collaborators = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([{ accountId: 1, login: 'ada', permission: 'write' }])
    const members = createMembersCache(collaborators, () => clock)
    await expect(members.get('o/r')).rejects.toThrow('down')
    await members.get('o/r')
    await members.get('o/r')
    expect(collaborators).toHaveBeenCalledTimes(2)
    clock += MEMBERS_TTL_MS
    await members.get('o/r')
    expect(collaborators).toHaveBeenCalledTimes(3)
    members.forget('o/r')
    await members.get('o/r')
    expect(collaborators).toHaveBeenCalledTimes(4)
  })
})

describe('vault.history', () => {
  const commit = (sha: string, subject: string) => ({
    sha,
    subject,
    date: '2026-09-30T00:00:00Z',
    author: 'Ada Holm',
    added: 1,
    removed: 0,
  })
  const repo = () =>
    ({
      log: async () => [commit('3', 'mixed'), commit('2', 'memory only'), commit('1', 'notes')],
      commitFiles: async () => [
        { sha: '3', files: ['a.md', 'AGENTS.md', 'Fin.app/data/items/x.json'] },
        { sha: '2', files: ['.holi/memory/x.md', '.holi/memory/index.md'] },
        { sha: '1', files: ['b.md'] },
      ],
    }) as unknown as ReturnType<CoreServices['repo']>

  it('hides commits that touched only the agent surface, and its paths in the rest', async () => {
    const { value } = await runCapability('vault.history', 'app', ctx({ repo }), {})
    expect(value).toEqual([
      {
        sha: '3',
        subject: 'mixed',
        date: '2026-09-30T00:00:00Z',
        author: 'Ada Holm',
        files: ['a.md'],
      },
      {
        sha: '1',
        subject: 'notes',
        date: '2026-09-30T00:00:00Z',
        author: 'Ada Holm',
        files: ['b.md'],
      },
    ])
  })

  it('refuses the history of an agent-surface path', async () => {
    expect(
      await refusal(
        runCapability('vault.history', 'app', ctx({ repo }), { path: '.claude/settings.json' }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('docs CLI writes', () => {
  const cliCtx = () => ctx({ syncState: () => ({ kind: 'up-to-date' }) }, null)

  beforeEach(() => {
    execFileSync('git', ['init', '-q', root])
  })

  it('creates and updates ordinary notes with exact-byte revisions', async () => {
    const created = await runCapability('docs.create', 'cli', cliCtx(), {
      path: 'with space.md',
      body: '# First\n',
    })
    expect(created.writes).toBe(true)
    expect(created.value).toMatchObject({
      path: 'with space.md',
      revision: createHash('sha256').update('# First\n').digest('hex'),
      commitSha: null,
      pushed: false,
      phase: 'commit',
      reason: 'vault-not-open',
    })
    await put('with space.md', '# First\n')
    const inspected = await runCapability('docs.inspect', 'cli', cliCtx(), {
      path: 'with space.md',
    })
    const revision = (inspected.value as { revision: string }).revision
    const updated = await runCapability('docs.update', 'cli', cliCtx(), {
      path: 'with space.md',
      revision,
      body: '# Second\n',
    })
    expect(updated.writes).toBe(true)
    expect(await readText(join(root, 'with space.md'), 'utf8')).toBe('# Second\n')
    await expect(
      runCapability('docs.delete', 'cli', cliCtx(), {
        path: 'with space.md',
        revision,
      }),
    ).rejects.toThrow(/Stale revision/)
  })

  it('inspects, updates, and deletes ordinary notes before the watcher lists them', async () => {
    await writeFile(join(root, 'unscanned.md'), 'first')
    const inspected = await runCapability('docs.inspect', 'cli', cliCtx(), {
      path: 'unscanned.md',
    })
    const revision = (inspected.value as { revision: string }).revision
    await runCapability('docs.update', 'cli', cliCtx(), {
      path: 'unscanned.md',
      revision,
      body: 'second',
    })
    expect(await readText(join(root, 'unscanned.md'), 'utf8')).toBe('second')
    await runCapability('docs.delete', 'cli', cliCtx(), {
      path: 'unscanned.md',
      revision: createHash('sha256').update('second').digest('hex'),
    })
    await expect(readText(join(root, 'unscanned.md'), 'utf8')).rejects.toThrow()
  })

  it('rechecks update and delete revisions after a competing editor save', async () => {
    for (const operation of ['docs.update', 'docs.delete'] as const) {
      const path = `${operation.split('.')[1]}.md`
      await writeFile(join(root, path), 'base')
      let entered!: () => void
      let release!: () => void
      const locked = new Promise<void>((resolve) => (entered = resolve))
      const gate = new Promise<void>((resolve) => (release = resolve))
      const editorSave = withFileLock(join(root, path), async () => {
        entered()
        await gate
        await writeFile(join(root, path), 'editor save')
      })
      await locked
      const mutation = runCapability('docs.' + operation.split('.')[1], 'cli', cliCtx(), {
        path,
        revision: createHash('sha256').update('base').digest('hex'),
        ...(operation === 'docs.update' ? { body: 'CLI update' } : {}),
      })
      release()
      await editorSave
      await expect(mutation).rejects.toThrow(/Stale revision/)
      expect(await readText(join(root, path), 'utf8')).toBe('editor save')
    }
  })

  it('refuses ignored and plugin-claimed notes even before the watcher lists them', async () => {
    await writeFile(join(root, '.gitignore'), 'ignored.md\n')
    await writeFile(join(root, 'ignored.md'), 'ignored')
    await writeFile(join(root, 'task.rent.md'), 'claimed')
    for (const path of ['ignored.md', 'task.rent.md']) {
      await expect(runCapability('docs.inspect', 'cli', cliCtx(), { path })).rejects.toThrow()
      await expect(
        runCapability('docs.update', 'cli', cliCtx(), {
          path,
          revision: createHash('sha256')
            .update(path === 'ignored.md' ? 'ignored' : 'claimed')
            .digest('hex'),
          body: 'bad',
        }),
      ).rejects.toThrow()
      await expect(
        runCapability('docs.delete', 'cli', cliCtx(), {
          path,
          revision: createHash('sha256')
            .update(path === 'ignored.md' ? 'ignored' : 'claimed')
            .digest('hex'),
        }),
      ).rejects.toThrow()
    }
  })

  it('creates nested notes, and refuses a symlink target and case aliases', async () => {
    const nested = await runCapability('docs.create', 'cli', cliCtx(), {
      path: 'nested/deep/note.md',
      body: 'nested',
    })
    expect(nested.value).toMatchObject({ path: 'nested/deep/note.md' })
    await writeFile(join(root, 'outside.md'), 'outside')
    await symlink(join(root, 'outside.md'), join(root, 'linked.md'))
    written.push('linked.md')
    await expect(
      runCapability('docs.update', 'cli', cliCtx(), {
        path: 'linked.md',
        revision: createHash('sha256').update('outside').digest('hex'),
        body: 'bad',
      }),
    ).rejects.toThrow()
    await put('.holi/memory/x.md', 'secret')
    await expect(
      runCapability('docs.create', 'cli', cliCtx(), {
        path: '.HOLI/memory/new.md',
        body: 'bad',
      }),
    ).rejects.toThrow()
  })

  it('offers retry settlement only to the CLI and requires an explicit absent marker', async () => {
    await put('retry.md', 'retry body')
    const revision = createHash('sha256').update('retry body').digest('hex')
    const result = await runCapability('docs.settle', 'cli', cliCtx(), {
      path: 'retry.md',
      revision,
    })
    expect(result.value).toMatchObject({ pushed: false, phase: 'commit', reason: 'vault-not-open' })
    await expect(
      runCapability('docs.settle', 'app', ctx({}), { path: 'retry.md', revision }),
    ).rejects.toThrow(/no such method/)
    await expect(
      runCapability('docs.settle', 'cli', cliCtx(), { path: 'gone.md' }),
    ).rejects.toThrow()
    expect(
      (await runCapability('docs.settle', 'cli', cliCtx(), { path: 'gone.md', absent: 'true' }))
        .value,
    ).toMatchObject({ revision: null, pushed: false })
    await expect(
      runCapability('docs.settle', 'cli', ctx({ syncState: () => null }, null), {
        path: 'gone.md',
        absent: 'true',
      }),
    ).rejects.toThrow(/vault-not-open/)
  })

  it('keeps writes CLI-only and refuses task and non-Markdown paths', async () => {
    await expect(
      runCapability('docs.create', 'app', ctx({}), {
        path: 'note.md',
        body: 'x',
      }),
    ).rejects.toThrow(/no such method/)
    for (const path of [
      'task.rent.md',
      'note.txt',
      'A.app/note.md',
      '.holi/memory/note.md',
      '.holi/settings/note.md',
    ]) {
      await expect(
        runCapability('docs.create', 'cli', cliCtx(), {
          path,
          body: 'x',
        }),
      ).rejects.toThrow()
    }
    await expect(
      runCapability(
        'docs.create',
        'cli',
        ctx({ syncState: () => ({ kind: 'up-to-date' }) }, null),
        { path: 'task.claimed.md', body: 'x' },
      ),
    ).rejects.toThrow()
  })
})

describe('docs.read', () => {
  it("refuses this machine's state", async () => {
    await put('.holi/state/bridge.local.env', 'HOLI_BRIDGE_TOKEN=abc123\n')
    expect(
      await refusal(
        runCapability('docs.read', 'app', ctx({}), {
          path: '.holi/state/bridge.local.env',
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('docs.render', () => {
  it('refuses what docs.read refuses', async () => {
    await put('.holi/memory/x.md', 'secret')
    expect(
      await refusal(runCapability('docs.render', 'app', ctx({}), { path: './.holi/memory/x.md' })),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses the agent surface named in another case, as macOS would open it', async () => {
    await put('.holi/memory/x.md', 'secret')
    for (const path of ['.holi/Memory/x.md', '.HOLI/MEMORY/x.md']) {
      expect(await refusal(runCapability('docs.render', 'app', ctx({}), { path }))).toMatchObject({
        code: 'NOT_FOUND',
      })
    }
  })

  it('renders a note', async () => {
    await put('a.md', '# Hi\n')
    const { value } = await runCapability('docs.render', 'app', ctx({}), { path: 'a.md' })
    expect(value).toContain('<h1')
  })
})

describe('docs.open', () => {
  it('shows a file the vault holds, by its normalised path', async () => {
    await put('notes/a.md', '# A\n')
    opened.length = 0
    const { text } = await runCapability('docs.open', 'cli', ctx({}, null), {
      path: './notes/a.md',
    })
    expect(opened).toEqual(['notes/a.md'])
    expect(text).toBe('opened notes/a.md')
  })

  it('refuses while Holi does not have the vault open', async () => {
    await put('notes/a.md', '# A\n')
    opened.length = 0
    expect(
      await refusal(
        runCapability('docs.open', 'cli', ctx({ syncState: () => null }, null), {
          path: 'notes/a.md',
        }),
      ),
    ).toMatchObject({ code: 'UNAVAILABLE', message: 'vault-not-open' })
    expect(opened).toEqual([])
  })

  it('refuses a path outside the vault, or one it does not hold', async () => {
    opened.length = 0
    expect(
      await refusal(runCapability('docs.open', 'cli', ctx({}, null), { path: '../x.md' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      await refusal(runCapability('docs.open', 'cli', ctx({}, null), { path: 'missing.md' })),
    ).toMatchObject({ code: 'NOT_FOUND' })
    expect(opened).toEqual([])
  })

  it('refuses a secret file and this machine state, even when the vault holds them', async () => {
    await put('.env', 'TOKEN=x\n')
    await put('.holi/state/bridge.json', '{}\n')
    opened.length = 0
    for (const path of ['.env', '.holi/state/bridge.json']) {
      expect(
        await refusal(runCapability('docs.open', 'cli', ctx({}, null), { path })),
      ).toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(opened).toEqual([])
  })

  it('shows a vault app, which is a directory', async () => {
    opened.length = 0
    const withApp: CapabilityContext = {
      ...ctx({}, null),
      snapshot: async () => ({ ...emptyVaultSnapshot(), dirs: ['Finance', 'Finance/Budget.app'] }),
    }
    await runCapability('docs.open', 'cli', withApp, { path: 'Finance/Budget.app' })
    expect(opened).toEqual(['Finance/Budget.app'])
    expect(
      await refusal(runCapability('docs.open', 'cli', withApp, { path: 'Finance' })),
    ).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('takes a bundle with a trailing slash, as a shell completes it', async () => {
    await put('Clock.app/index.html', '<p></p>')
    opened.length = 0
    await runCapability('docs.open', 'cli', ctx({}, null), { path: 'Clock.app/' })
    expect(opened).toEqual(['Clock.app'])
    expect(
      await refusal(runCapability('docs.open', 'cli', ctx({}, null), { path: 'Gone.app' })),
    ).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('docs.screenshot', () => {
  it("writes the tab's PNG outside the vault, owner-only, and prints its absolute path", async () => {
    await put('notes/a.md', '# A\n')
    const { text } = await runCapability('docs.screenshot', 'cli', ctx({}, null), {
      path: 'notes/a.md',
    })
    try {
      expect(dirname(text)).toBe(SCREENSHOT_DIR)
      expect([...(await readText(text))]).toEqual([0x89, 0x50, 0x4e, 0x47])
      if (process.platform !== 'win32') expect((await stat(text)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(text, { force: true })
    }
  })
})

describe('tasks.complete', () => {
  it('rolls a recurring task forward, as the board does', async () => {
    await put(
      'task.rent.md',
      '---\nstatus: todo\ndue: 2026-09-30\nrecurrence:\n  frequency: monthly\n  interval: 1\n---\n\n# Rent\n',
    )
    const { value, writes } = await runCapability('tasks.complete', 'app', ctx({}), {
      path: 'task.rent.md',
    })
    expect(writes).toBe(true)
    expect(value).toMatchObject({ status: 'todo', due: '2026-10-30' })
    expect(await readText(join(root, 'task.rent.md'), 'utf8')).toContain('2026-10-30')
  })

  it('refuses a task on the agent surface, in any case', async () => {
    await put('.holi/memory/task.x.md', '---\nstatus: todo\n---\n\n# X\n')
    expect(
      await refusal(
        runCapability('tasks.complete', 'app', ctx({}), { path: '.holi/Memory/task.x.md' }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('never completes a task through a symlink at the app door', async () => {
    await put('elsewhere/task.x.md', '---\nstatus: todo\n---\n\n# X\n')
    await symlink(join(root, 'elsewhere'), join(root, 'link'))
    written.push('link/task.x.md')
    expect(
      await refusal(runCapability('tasks.complete', 'app', ctx({}), { path: 'link/task.x.md' })),
    ).toMatchObject({ code: 'FORBIDDEN' })
    expect(await readText(join(root, 'elsewhere/task.x.md'), 'utf8')).toContain('status: todo')
  })

  it('refuses a task on the agent surface', async () => {
    expect(
      await refusal(
        runCapability('tasks.complete', 'app', ctx({}), { path: '.holi/memory/task.x.md' }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('docs.write', () => {
  const write = (path: string, text: string, base: string | null) =>
    runCapability('docs.write', 'app', ctx({}), { path, text, base })

  it('writes a note over the text the app read, and creates one that is not there', async () => {
    await put('a.md', 'one\n')
    expect((await write('a.md', 'two\n', 'one\n')).writes).toBe(true)
    expect(await readText(join(root, 'a.md'), 'utf8')).toBe('two\n')
    await write('notes/b.md', 'new\n', null)
    expect(await readText(join(root, 'notes/b.md'), 'utf8')).toBe('new\n')
  })

  it('refuses a note that changed since it was read, and writes nothing', async () => {
    await put('a.md', 'theirs\n')
    expect(await refusal(write('a.md', 'mine\n', 'old\n'))).toMatchObject({ code: 'CONFLICT' })
    expect(await refusal(write('a.md', 'mine\n', null))).toMatchObject({ code: 'CONFLICT' })
    expect(await refusal(write('gone.md', 'mine\n', 'old\n'))).toMatchObject({
      code: 'CONFLICT',
    })
    expect(await readText(join(root, 'a.md'), 'utf8')).toBe('theirs\n')
  })

  it('writes only shared notes: nothing hidden, local, in a bundle or on the agent surface', async () => {
    for (const path of [
      '.holi/settings/app.md',
      '.claude/skills/x.md',
      'AGENTS.md',
      'me.local.md',
      'notes/mine.local.d/x.md',
      'Budget.app/README.md',
      'Budget.app/data/items/x.md',
      'notes/AGENTS.md',
      'notes/claude.md',
      'notes/Claude.MD/x.md',
      'claude.md',
      'Memory.md',
    ]) {
      expect(await refusal(write(path, 'x', null))).toMatchObject({ code: 'FORBIDDEN' })
    }
    expect(await refusal(write('a.txt', 'x', null))).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('never writes through a symlink', async () => {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'link'))
    expect(await refusal(write('link/x.md', 'x', null))).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lets one of two writes over the same base land, and refuses the other', async () => {
    await put('a.md', 'one\n')
    const results = await Promise.all([
      refusal(write('a.md', 'mine\n', 'one\n')),
      refusal(write('a.md', 'theirs\n', 'one\n')),
    ])
    expect(results.filter((r) => r === null)).toHaveLength(1)
    expect(results.filter((r) => r?.code === 'CONFLICT')).toHaveLength(1)
  })

  it("changes a task file's body only: its fields are tasks.update's", async () => {
    const task = '---\nstatus: todo\ndue: 2026-09-30\n---\n\n# Rent\n'
    await put('task.rent.md', task)
    const body = '---\nstatus: todo\ndue: 2026-09-30\n---\n\n# Rent\n\nPaid by transfer.\n'
    expect((await write('task.rent.md', body, task)).writes).toBe(true)
    for (const text of [
      '---\nstatus: done\ndue: 2026-09-30\n---\n\n# Rent\n\nPaid by transfer.\n',
      '---\nstatus: todo\n---\n\n# Rent\n\nPaid by transfer.\n',
      '# Rent\n',
    ]) {
      expect(await refusal(write('task.rent.md', text, body))).toMatchObject({
        code: 'BAD_REQUEST',
      })
    }
    expect(await refusal(write('task.new.md', task, null))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await readText(join(root, 'task.rent.md'), 'utf8')).toBe(body)
  })

  it('needs the base, so no write is blind', async () => {
    expect(
      await refusal(runCapability('docs.write', 'app', ctx({}), { path: 'a.md', text: 'x' })),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('tasks.update', () => {
  const task =
    '---\nstatus: todo\ndue: 2026-09-30\npriority: high\nrecurrence:\n  frequency: monthly\n  interval: 1\n---\n\n# Rent\n'

  it('sets and clears fields as the board does', async () => {
    await put('task.rent.md', task)
    const { value } = await runCapability('tasks.update', 'app', ctx({}), {
      path: 'task.rent.md',
      patch: { due: '2026-10-02', priority: null, tags: ['home'] },
    })
    expect(value).toMatchObject({ due: '2026-10-02', tags: ['home'] })
    expect(value).not.toHaveProperty('priority', 'high')
    const text = await readText(join(root, 'task.rent.md'), 'utf8')
    expect(text).toContain('2026-10-02')
    expect(text).not.toContain('priority')
  })

  it('makes done completion, so a recurring task rolls forward', async () => {
    await put('task.rent.md', task)
    const { value } = await runCapability('tasks.update', 'app', ctx({}), {
      path: 'task.rent.md',
      patch: { status: 'done' },
    })
    expect(value).toMatchObject({ status: 'todo', due: '2026-10-30' })
  })

  it("refuses what the board's field edit refuses, and the task's text", async () => {
    await put('task.rent.md', task)
    // Not a status: any word is one, kept as written (docs/features/tasks.md).
    for (const patch of [{ colour: 'red' }, { description: '# Rent' }]) {
      expect(
        await refusal(
          runCapability('tasks.update', 'app', ctx({}), { path: 'task.rent.md', patch }),
        ),
      ).toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(await readText(join(root, 'task.rent.md'), 'utf8')).toBe(task)
  })

  it('writes only where an app may write', async () => {
    await put('.holi/x/task.a.md', task)
    expect(
      await refusal(
        runCapability('tasks.update', 'app', ctx({}), {
          path: '.holi/x/task.a.md',
          patch: { status: 'doing' },
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('tasks.list', () => {
  it('tells an app only the tasks it may read, and the agent every one', async () => {
    const task = (path: string) => ({ path, title: path, status: 'todo', tags: [], assignees: [] })
    const items = ['ops/task.a.md', '.holi/memory/task.b.md', 'Budget.app/data/task.c.md'].map(task)
    const withTasks = (bundle: string | null): CapabilityContext => ({
      ...ctx({}, bundle),
      snapshot: async () => ({
        ...emptyVaultSnapshot(),
        claimed: { tasks: { items, broken: [] } },
      }),
    })
    const paths = async (door: 'app' | 'cli', bundle: string | null) =>
      (
        (await runCapability('tasks.list', door, withTasks(bundle), {})).value as { path: string }[]
      ).map((t) => t.path)
    expect(await paths('app', 'A.app')).toEqual(['ops/task.a.md'])
    expect(await paths('cli', null)).toHaveLength(3)
  })
})

describe('tasks.create at the app door', () => {
  it('creates a task where an app may write, and nowhere else', async () => {
    const { value } = await runCapability('tasks.create', 'app', ctx({}), {
      title: 'Call the vendor',
      folder: 'ops',
      extra: { due: '2026-10-01' },
    })
    // Private unless asked otherwise, though an app may write no other local file.
    expect(value).toEqual({ path: 'ops/task.call-the-vendor.local.md' })
    expect(await readText(join(root, 'ops/task.call-the-vendor.local.md'), 'utf8')).toContain(
      '2026-10-01',
    )
    const shared = await runCapability('tasks.create', 'app', ctx({}), {
      title: 'Call the vendor',
      folder: 'ops',
      shared: true,
    })
    // The private one holds the name, so the shared one takes the next.
    expect(shared.value).toEqual({ path: 'ops/task.call-the-vendor-2.md' })
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'link'))
    for (const folder of ['.claude', 'Budget.app', 'mine.local.d', 'link', 'CLAUDE.md']) {
      for (const shared of [false, true]) {
        expect(
          await refusal(
            runCapability('tasks.create', 'app', ctx({}), { title: 'X', folder, shared }),
          ),
        ).toMatchObject({ code: 'FORBIDDEN' })
      }
    }
  })

  it('completes a private task, but reaches no other local file', async () => {
    await put('ops/task.a.local.md', '---\nstatus: todo\n---\n')
    await put('USER.local.md', 'me')
    const withTask = (): CapabilityContext => ({
      ...ctx({}),
      snapshot: async () => ({
        ...emptyVaultSnapshot(),
        files: [{ path: 'USER.local.md', updatedAt: '' }],
        claimed: {
          tasks: {
            items: [parseTaskFile('---\nstatus: todo\n---\n', 'ops/task.a.local.md')],
            broken: [],
          },
        },
      }),
    })
    await runCapability('tasks.complete', 'app', withTask(), { path: 'ops/task.a.local.md' })
    expect(await readText(join(root, 'ops/task.a.local.md'), 'utf8')).toContain('status: done')
    expect(
      await refusal(
        runCapability('tasks.update', 'app', withTask(), {
          path: 'USER.local.md',
          patch: { status: 'done' },
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('tasks.create, twice at once', () => {
  it('gives two creates with one title two files', async () => {
    const create = () => runCapability('tasks.create', 'app', ctx({}), { title: 'Call' })
    const [a, b] = await Promise.all([create(), create()])
    expect(new Set([a.value, b.value].map((v) => (v as { path: string }).path))).toEqual(
      new Set(['task.call.local.md', 'task.call-2.local.md']),
    )
  })
})

describe('Google reads', () => {
  const range = { from: '2026-09-30T00:00:00Z', to: '2026-10-01T00:00:00Z' }

  it('need the manifest flag first', async () => {
    await put('A.app/app.yaml', '')
    grantStatus = async () => ({ codeHash: 'h', affordances: [] })
    expect(await refusal(runCapability('google.search', 'app', ctx({}), {}, admit))).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('dangerously-allow'),
    })
  })

  it('then the approval', async () => {
    grantStatus = async () => ({
      codeHash: 'h',
      affordances: [{ affordance: 'calendar' as const, granted: false }],
    })
    expect(
      await refusal(runCapability('google.agenda', 'app', ctx({}), range, admit)),
    ).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('not approved'),
    })
  })

  it('then a connected account', async () => {
    grantStatus = async () => ({
      codeHash: 'h',
      affordances: [{ affordance: 'mail' as const, granted: true }],
    })
    expect(await refusal(runCapability('google.search', 'app', ctx({}), {}, admit))).toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  it('ask no grant at the CLI door, only a connected account', async () => {
    expect(await refusal(runCapability('google.search', 'cli', ctx({}, null), {}))).toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  it('bound the calendar window', async () => {
    expect(
      await refusal(
        runCapability(
          'google.agenda',
          'app',
          ctx({}),
          { from: '2026-01-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
          admit,
        ),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' })
  })
})
