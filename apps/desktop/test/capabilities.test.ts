import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile as readText, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { GoogleAccountsManager } from '../src/plugins/google/main/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../src/plugins/google/main/capabilities'
import { taskCapabilities, TASKS_NAMESPACES } from '../src/plugins/tasks/main/capabilities'
import { MEMBERS_TTL_MS, createMembersCache } from '../src/main/github/members-cache'

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
      dirs: written.filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/'))),
    }),
    core: { ...noCoreServices(), ...core },
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
    const { value, text } = await runCapability('sync.status', 'cli', ctx({}, null), {})
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
  it("writes the tab's PNG as machine-local state and prints its path", async () => {
    await put('notes/a.md', '# A\n')
    const { text } = await runCapability('docs.screenshot', 'cli', ctx({}, null), {
      path: 'notes/a.md',
    })
    expect(text).toMatch(/^\.holi\/state\/out\/.+\.local\.png$/)
    expect([...(await readText(join(root, text)))]).toEqual([0x89, 0x50, 0x4e, 0x47])
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
    for (const patch of [{ status: 'finished' }, { colour: 'red' }, { description: '# Rent' }]) {
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

describe('tasks.create at the app door', () => {
  it('creates a task where an app may write, and nowhere else', async () => {
    const { value } = await runCapability('tasks.create', 'app', ctx({}), {
      title: 'Call the vendor',
      folder: 'ops',
      extra: { due: '2026-10-01' },
    })
    expect(value).toEqual({ path: 'ops/task.call-the-vendor.md' })
    expect(await readText(join(root, 'ops/task.call-the-vendor.md'), 'utf8')).toContain(
      '2026-10-01',
    )
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'link'))
    for (const folder of ['.claude', 'Budget.app', 'mine.local.d', 'link', 'CLAUDE.md']) {
      expect(
        await refusal(runCapability('tasks.create', 'app', ctx({}), { title: 'X', folder })),
      ).toMatchObject({ code: 'FORBIDDEN' })
    }
  })
})

describe('tasks.create, twice at once', () => {
  it('gives two creates with one title two files', async () => {
    const create = () => runCapability('tasks.create', 'app', ctx({}), { title: 'Call' })
    const [a, b] = await Promise.all([create(), create()])
    expect(new Set([a.value, b.value].map((v) => (v as { path: string }).path))).toEqual(
      new Set(['task.call.md', 'task.call-2.md']),
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
