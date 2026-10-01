import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile as readText, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'
import type { CapabilityError } from '../src/main/capabilities/error'
import {
  cap,
  createCapabilityRegistry,
  type CapabilityContext,
} from '../src/main/capabilities/registry'
import { admitApps, type AppGrants } from '../src/main/apps/app-grants'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { noCoreServices, type CoreServices } from '../src/main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../src/main/capabilities/vault-caps'
import type { GoogleAccountsManager } from '../src/main/google/accounts'
import { googleCapabilities, GOOGLE_NAMESPACES } from '../src/main/google/capabilities'
import { taskCapabilities, TASK_NAMESPACES } from '../src/main/vault/task-capabilities'
import { MEMBERS_TTL_MS, createMembersCache } from '../src/main/github/members-cache'

const registry = createCapabilityRegistry()
registry.register(VAULT_NAMESPACES, vaultCapabilities({ updateSkills: async () => '' }))
registry.register(TASK_NAMESPACES, taskCapabilities({ today: () => '2026-09-30' }))
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
      { kind: 'path' as const, key: 'memory/x.md' },
      { kind: 'terminal' as const, key: 't1' },
      { kind: 'command' as const, key: 'board.open' },
      { kind: 'surface' as const, key: 'board' },
      { kind: 'app' as const, key: 'B.app' },
    ]
    const { value } = await runCapability('vault.recents', 'app', ctx({ recents }), undefined)
    expect(value).toEqual([
      { kind: 'path', key: 'a.md' },
      { kind: 'surface', key: 'board' },
      { kind: 'app', key: 'B.app' },
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
        { sha: '2', files: ['memory/x.md', 'memory/index.md'] },
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
    await put('memory/x.md', 'secret')
    expect(
      await refusal(runCapability('docs.render', 'app', ctx({}), { path: './memory/x.md' })),
    ).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses the agent surface named in another case, as macOS would open it', async () => {
    await put('memory/x.md', 'secret')
    for (const path of ['Memory/x.md', 'MEMORY/x.md']) {
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
    await put('memory/task.x.md', '---\nstatus: todo\n---\n\n# X\n')
    expect(
      await refusal(runCapability('tasks.complete', 'app', ctx({}), { path: 'Memory/task.x.md' })),
    ).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a task on the agent surface', async () => {
    expect(
      await refusal(runCapability('tasks.complete', 'app', ctx({}), { path: 'memory/task.x.md' })),
    ).toMatchObject({ code: 'FORBIDDEN' })
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
