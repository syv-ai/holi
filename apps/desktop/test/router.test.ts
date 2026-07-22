import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskFile } from '@holi/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRouter } from '../src/main/router'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'
import { VaultRegistry } from '../src/main/vault/registry'

const REMOTE = 'syv-ai/1brain'
const TODAY = '2026-07-21'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`),
  decryptString: (buf) => Buffer.from(buf.toString('utf8').slice(4), 'base64').toString('utf8'),
}

/** A signed-out session over a real store, for the suites that do not care. */
async function idleSession(base: string): Promise<GitHubSession> {
  return GitHubSession.load({
    store: new TokenStore(join(base, 'github-auth.enc'), storage),
    fetch: (() => {
      throw new Error('no network in this rig')
    }) as unknown as typeof globalThis.fetch,
  })
}

async function rig(files: Record<string, string> = {}) {
  const base = await mkdtemp(join(tmpdir(), 'holi-rt-'))
  dirs.push(base)
  const root = join(base, 'clone')
  for (const [rel, text] of Object.entries(files)) {
    await writeFile(join(root, rel), text, 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root, rel, '..'), { recursive: true })
      await writeFile(join(root, rel), text, 'utf8')
    })
  }
  const registry = new VaultRegistry(join(base, 'vaults.json'))
  await registry.add({
    remote: REMOTE,
    path: root,
    name: '1brain',
    lastOpenedAt: '2026-07-01T00:00:00Z',
  })
  const caller = createRouter({
    registry,
    session: await idleSession(base),
    openExternal: async () => {},
    now: () => '2026-07-21T12:00:00Z',
    today: () => TODAY,
  }).createCaller({})
  return { caller, root, registry }
}

describe('vaults', () => {
  it('lists the registry', async () => {
    const { caller } = await rig()
    expect((await caller.vaults.list()).map((v) => v.remote)).toEqual([REMOTE])
  })

  it('open returns the vault contents and stamps lastOpenedAt', async () => {
    const { caller, registry } = await rig({ 'a.md': '# A\n' })
    const snap = await caller.vaults.open({ remote: REMOTE })
    expect(snap.docs.map((d) => d.path)).toEqual(['a.md'])
    expect((await registry.list())[0]!.lastOpenedAt).toBe('2026-07-21T12:00:00Z')
  })

  it('rejects an unknown vault once, in one place', async () => {
    const { caller } = await rig()
    await expect(caller.vaults.snapshot({ remote: 'nope/nope' })).rejects.toThrow(/no such vault/)
    await expect(caller.notes.read({ remote: 'nope/nope', path: 'a.md' })).rejects.toThrow(
      /no such vault/,
    )
  })

  it('remove deregisters the vault but leaves the clone on disk', async () => {
    const { caller, root } = await rig({ 'a.md': '# A\n' })
    await caller.vaults.remove({ remote: REMOTE })
    expect(await caller.vaults.list()).toEqual([])
    // unpublished work must never be a casualty of forgetting a vault
    await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('# A\n')
  })
})

describe('notes', () => {
  it('reads and writes', async () => {
    const { caller, root } = await rig({ 'a.md': '# A\n' })
    expect(await caller.notes.read({ remote: REMOTE, path: 'a.md' })).toBe('# A\n')

    await caller.notes.write({ remote: REMOTE, path: 'a.md', text: '# B\n' })
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# B\n')
  })

  it('creates, including the folders on the way', async () => {
    const { caller, root } = await rig()
    await caller.notes.create({ remote: REMOTE, path: 'projects/q2/new.md', text: 'hi' })
    expect(await readFile(join(root, 'projects/q2/new.md'), 'utf8')).toBe('hi')
  })

  it('refuses to create over an existing note', async () => {
    const { caller } = await rig({ 'a.md': 'mine\n' })
    await expect(
      caller.notes.create({ remote: REMOTE, path: 'a.md', text: 'theirs' }),
    ).rejects.toThrow(/already exists/)
  })

  it('reports a missing note rather than returning empty text', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE, path: 'ghost.md' })).rejects.toThrow(/ghost/)
  })

  it('deletes', async () => {
    const { caller } = await rig({ 'a.md': '# A\n' })
    await caller.notes.delete({ remote: REMOTE, path: 'a.md' })
    await expect(caller.notes.read({ remote: REMOTE, path: 'a.md' })).rejects.toThrow()
  })

  it('deleting something already gone is not an error', async () => {
    const { caller } = await rig()
    await expect(caller.notes.delete({ remote: REMOTE, path: 'ghost.md' })).resolves.toEqual({
      ok: true,
    })
  })
})

describe('tasks', () => {
  it('creates `task.<slug>.md` in the lane it was added to, with that column’s status', async () => {
    const { caller, root } = await rig()
    const { path } = await caller.tasks.create({
      remote: REMOTE,
      folder: 'projects/q2',
      title: 'Review the Q2 doc',
      status: 'doing',
    })
    expect(path).toBe('projects/q2/task.review-the-q2-doc.md')

    const task = parseTaskFile(await readFile(join(root, path), 'utf8'), path)
    expect(task.title).toBe('Review the Q2 doc')
    expect(task.status).toBe('doing')
  })

  it('defaults to todo at the vault root', async () => {
    const { caller } = await rig()
    const { path } = await caller.tasks.create({ remote: REMOTE, title: 'Call the vendor' })
    expect(path).toBe('task.call-the-vendor.md')
  })

  it('suffixes a colliding slug rather than refusing or clobbering', async () => {
    // Two tasks can honestly share a title, and a board quick-add that errors on
    // a repeated title reads as a bug.
    const { caller } = await rig({ 'task.call-the-vendor.md': '---\ntitle: Call the vendor\n---\n' })
    expect((await caller.tasks.create({ remote: REMOTE, title: 'Call the vendor' })).path).toBe(
      'task.call-the-vendor-2.md',
    )
    expect((await caller.tasks.create({ remote: REMOTE, title: 'Call the vendor' })).path).toBe(
      'task.call-the-vendor-3.md',
    )
  })
})

describe('tasks.update', () => {
  const FILE = [
    '---',
    'title: Review',
    'status: todo',
    'due: 2026-07-20',
    'priority: high',
    '---',
    '',
    'The body.',
    '',
  ].join('\n')

  it('rewrites the fields it names and leaves the rest alone', async () => {
    const { caller } = await rig({ 'task.review.md': FILE })
    const task = await caller.tasks.update({
      remote: REMOTE,
      path: 'task.review.md',
      patch: { status: 'doing' },
    })
    expect(task.status).toBe('doing')
    expect(task.due).toBe('2026-07-20')
    expect(task.priority).toBe('high')
    expect(task.description).toBe('The body.')
  })

  it('clears a field with null', async () => {
    const { caller } = await rig({ 'task.review.md': FILE })
    const task = await caller.tasks.update({
      remote: REMOTE,
      path: 'task.review.md',
      patch: { due: null },
    })
    expect(task.due).toBeUndefined()
  })

  it('carries unknown frontmatter keys through the rewrite', async () => {
    // A whole-file rewrite is what an edit IS, so anything the parser did not
    // understand — a pre-D60 `id`, a key another tool owns — must survive it.
    const { caller, root } = await rig({
      'task.legacy.md': '---\ntitle: Legacy\nstatus: todo\nid: abc\n---\n',
    })
    await caller.tasks.update({
      remote: REMOTE,
      path: 'task.legacy.md',
      patch: { status: 'done' },
    })
    expect(await readFile(join(root, 'task.legacy.md'), 'utf8')).toContain('id: abc')
  })

  it('refuses a value outside the vocabulary', async () => {
    const { caller } = await rig({ 'task.review.md': FILE })
    await expect(
      caller.tasks.update({ remote: REMOTE, path: 'task.review.md', patch: { status: 'blocked' } }),
    ).rejects.toThrow(/status must be one of/)
  })

  it('reports a missing task rather than creating one', async () => {
    const { caller } = await rig()
    await expect(
      caller.tasks.update({ remote: REMOTE, path: 'task.ghost.md', patch: { status: 'done' } }),
    ).rejects.toThrow(/task.ghost.md/)
  })
})

describe('tasks.complete', () => {
  it('marks a plain task done', async () => {
    const { caller } = await rig({ 'task.review.md': '---\ntitle: Review\nstatus: doing\n---\n' })
    const task = await caller.tasks.complete({ remote: REMOTE, path: 'task.review.md' })
    expect(task.status).toBe('done')
  })

  it('rolls a recurring task forward instead of persisting done', async () => {
    // The card's checkbox goes through here, never a bare `status: done` write —
    // this is the single roll-forward path (prd/tasks.md §Board UX).
    const { caller } = await rig({
      'task.standup.md': [
        '---',
        'title: Standup',
        'status: todo',
        'due: 2026-07-20',
        'recurrence: { frequency: weekly, interval: 1 }',
        '---',
      ].join('\n'),
    })
    const task = await caller.tasks.complete({ remote: REMOTE, path: 'task.standup.md' })
    expect(task.status).toBe('todo')
    expect(task.due).toBe('2026-07-27')
  })

  it('catches a stale recurring task up to on-or-after today', async () => {
    // A decade-stale daily task must not roll to a date still in the past.
    const { caller } = await rig({
      'task.water.md': [
        '---',
        'title: Water the plants',
        'status: todo',
        'due: 2020-01-01',
        'recurrence: { frequency: daily, interval: 1 }',
        '---',
      ].join('\n'),
    })
    const task = await caller.tasks.complete({ remote: REMOTE, path: 'task.water.md' })
    expect(task.due! >= TODAY).toBe(true)
  })

  it('shifts an absolute reminder by the same day-delta the due date moved', async () => {
    const { caller } = await rig({
      'task.standup.md': [
        '---',
        'title: Standup',
        'status: todo',
        'due: 2026-07-20',
        'reminder: 2026-07-19T08:30',
        'recurrence: { frequency: weekly, interval: 1 }',
        '---',
      ].join('\n'),
    })
    const task = await caller.tasks.complete({ remote: REMOTE, path: 'task.standup.md' })
    expect(task.reminder).toBe('2026-07-26T08:30')
  })

  it('leaves a relative reminder alone — it re-resolves against the new due on its own', async () => {
    const { caller } = await rig({
      'task.standup.md': [
        '---',
        'title: Standup',
        'status: todo',
        'due: 2026-07-20',
        'reminder: 1d',
        'recurrence: { frequency: weekly, interval: 1 }',
        '---',
      ].join('\n'),
    })
    expect((await caller.tasks.complete({ remote: REMOTE, path: 'task.standup.md' })).reminder).toBe(
      '1d',
    )
  })

  it('ends the series when the recurrence has run past its endDate', async () => {
    const { caller } = await rig({
      'task.sprint.md': [
        '---',
        'title: Sprint review',
        'status: todo',
        'due: 2026-07-20',
        'recurrence: { frequency: weekly, interval: 1, endDate: 2026-07-22 }',
        '---',
      ].join('\n'),
    })
    const task = await caller.tasks.complete({ remote: REMOTE, path: 'task.sprint.md' })
    expect(task.status).toBe('done')
  })

  it('completes a recurring task that has no due date — there is nothing to advance from', async () => {
    const { caller } = await rig({
      'task.someday.md': [
        '---',
        'title: Someday',
        'status: todo',
        'recurrence: { frequency: weekly, interval: 1 }',
        '---',
      ].join('\n'),
    })
    expect((await caller.tasks.complete({ remote: REMOTE, path: 'task.someday.md' })).status).toBe(
      'done',
    )
  })
})

describe('tasks.delete', () => {
  it('removes the file', async () => {
    const { caller, root } = await rig({ 'task.review.md': '---\ntitle: Review\n---\n' })
    await caller.tasks.delete({ remote: REMOTE, path: 'task.review.md' })
    await expect(readFile(join(root, 'task.review.md'), 'utf8')).rejects.toThrow()
  })
})

describe('path safety', () => {
  // The only thing between an input and the user's filesystem, now that
  // server-side authorization is gone.
  const escapes = ['../outside.md', '/etc/passwd', 'a/../../b.md']

  it('refuses to read outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.read({ remote: REMOTE, path })).rejects.toThrow()
    }
  })

  it('refuses to write outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.write({ remote: REMOTE, path, text: 'x' })).rejects.toThrow()
    }
  })

  it('refuses to delete outside the vault', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(caller.notes.delete({ remote: REMOTE, path })).rejects.toThrow()
    }
  })

  it('guards the task procedures too — every path-taking entry point, not just notes', async () => {
    const { caller } = await rig()
    for (const path of escapes) {
      await expect(
        caller.tasks.update({ remote: REMOTE, path, patch: { status: 'done' } }),
      ).rejects.toThrow()
      await expect(caller.tasks.complete({ remote: REMOTE, path })).rejects.toThrow()
      await expect(caller.tasks.delete({ remote: REMOTE, path })).rejects.toThrow()
    }
  })

  it('a folder cannot carry a task out of the vault either', async () => {
    const { caller } = await rig()
    await expect(
      caller.tasks.create({ remote: REMOTE, folder: '../outside', title: 'Sneaky' }),
    ).rejects.toThrow()
  })
})

describe('input validation', () => {
  it('rejects a missing required field', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE } as never)).rejects.toThrow(/path is required/)
  })

  it('rejects a non-string where a string belongs', async () => {
    const { caller } = await rig()
    await expect(caller.notes.read({ remote: REMOTE, path: 7 } as never)).rejects.toThrow(
      /path must be a string/,
    )
  })

  it('allows an optional field to be omitted', async () => {
    const { caller } = await rig()
    await expect(caller.notes.create({ remote: REMOTE, path: 'x.md' })).resolves.toEqual({
      path: 'x.md',
    })
  })
})

// ─── auth & github ─────────────────────────────────────────────────────────

interface Scripted {
  status?: number
  body: unknown
  headers?: Record<string, string>
}

const TOKEN = 'gho_16C7e42F292c6912E7710c838347Ae178B4a'

const CODE = {
  device_code: '3584d83530557fdd1f46af8289938c8ef79f9dc5',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}
const GRANT = { access_token: TOKEN, token_type: 'bearer', scope: 'repo,read:user,read:org' }
const VIEWER = {
  login: 'nthomsencph',
  id: 583231,
  avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
  name: 'Nicolai Thomsen',
  type: 'User',
}

const ghRepo = (over: Record<string, unknown> = {}) => ({
  name: '1brain',
  full_name: REMOTE,
  private: true,
  visibility: 'private',
  owner: { login: 'syv-ai', id: 9, type: 'Organization' },
  default_branch: 'main',
  pushed_at: '2026-07-20T10:00:00Z',
  permissions: { admin: true, push: true, pull: true },
  ...over,
})

const seeded = (): StoredAuth => ({
  token: TOKEN,
  accountId: 583231,
  login: 'nthomsencph',
  name: 'Nicolai Thomsen',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  scopes: ['repo', 'read:user', 'read:org'],
})

/** A caller wired to a scripted network, and a recording `openExternal`. */
async function authRig(routes: Record<string, Scripted[]>, seed?: StoredAuth) {
  const base = await mkdtemp(join(tmpdir(), 'holi-auth-'))
  dirs.push(base)

  const store = new TokenStore(join(base, 'github-auth.enc'), storage)
  if (seed) await store.write(seed)

  const cursor = new Map<string, number>()
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input))
    const script = routes[url.pathname]
    if (!script) throw new Error(`unrouted request: ${url.pathname}`)
    const i = cursor.get(url.pathname) ?? 0
    cursor.set(url.pathname, i + 1)
    const next = script[Math.min(i, script.length - 1)]!
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    })
  }) as unknown as typeof globalThis.fetch

  const session = await GitHubSession.load({
    store,
    clientId: 'Iv1.test0client0id',
    fetch,
    sleep: async () => {},
  })

  const registry = new VaultRegistry(join(base, 'vaults.json'))
  const openExternal = vi.fn(async () => {})
  const caller = createRouter({ registry, session, openExternal }).createCaller({})
  return { caller, session, store, openExternal }
}

const SIGN_IN = {
  '/login/device/code': [{ body: CODE }],
  '/login/oauth/access_token': [{ body: GRANT }],
  '/user': [{ body: VIEWER }],
}

describe('auth', () => {
  it('status returns null when signed out', async () => {
    const { caller } = await authRig({})
    expect(await caller.auth.status()).toEqual({ viewer: null })
  })

  it('status returns the viewer when signed in', async () => {
    const { caller } = await authRig({}, seeded())
    expect(await caller.auth.status()).toEqual({
      viewer: {
        login: 'nthomsencph',
        name: 'Nicolai Thomsen',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
      },
    })
  })

  it('status never returns the token', async () => {
    // Asserted on the serialized result, not on the type. A type says what we
    // meant; this says what we shipped, and it is the kind of thing a later
    // convenience field silently re-adds.
    const { caller } = await authRig({}, seeded())
    expect(JSON.stringify(await caller.auth.status())).not.toContain(TOKEN)
  })

  it('status returns exactly the three fields FR-5 names', async () => {
    // accountId is our identity key, not the renderer's, and it is absent.
    // Asserted on the *keys*: searching the JSON for the id itself would
    // always hit, because GitHub embeds the account id in the avatar URL.
    const { caller } = await authRig({}, seeded())
    const { viewer } = await caller.auth.status()
    expect(Object.keys(viewer ?? {}).sort()).toEqual(['avatarUrl', 'login', 'name'])
  })

  it('signIn returns the user code and verification uri', async () => {
    const { caller } = await authRig(SIGN_IN)
    const started = await caller.auth.signIn()
    expect(started.userCode).toBe('WDJB-MJHT')
    expect(started.verificationUri).toBe('https://github.com/login/device')
    expect(typeof started.expiresAt).toBe('number')
  })

  it('signIn opens the verification uri in the system browser', async () => {
    // The URI GitHub returned, not a hardcoded one: GitHub is free to change
    // it, and the code on screen belongs to whatever it says.
    const { caller, openExternal } = await authRig(SIGN_IN)
    await caller.auth.signIn()
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device')
  })

  it('awaitSignIn resolves with the viewer once the grant lands', async () => {
    const { caller } = await authRig(SIGN_IN)
    await caller.auth.signIn()

    expect(await caller.auth.awaitSignIn()).toEqual({
      kind: 'granted',
      viewer: {
        login: 'nthomsencph',
        name: 'Nicolai Thomsen',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
      },
    })
  })

  it('awaitSignIn never returns the token', async () => {
    const { caller } = await authRig(SIGN_IN)
    await caller.auth.signIn()
    expect(JSON.stringify(await caller.auth.awaitSignIn())).not.toContain(TOKEN)
  })

  it('awaitSignIn reports a denial without throwing', async () => {
    const { caller } = await authRig({
      ...SIGN_IN,
      '/login/oauth/access_token': [{ body: { error: 'access_denied' } }],
    })
    await caller.auth.signIn()
    expect(await caller.auth.awaitSignIn()).toEqual({ kind: 'denied' })
  })

  it('awaitSignIn fails clearly when no sign-in was started', async () => {
    const { caller } = await authRig({})
    await expect(caller.auth.awaitSignIn()).rejects.toThrow(/no sign-in in progress/)
  })

  it('cancelSignIn stops the flow', async () => {
    const { caller } = await authRig({
      ...SIGN_IN,
      '/login/oauth/access_token': [{ body: { error: 'authorization_pending' } }],
    })
    await caller.auth.signIn()
    await caller.auth.cancelSignIn()
    expect(await caller.auth.awaitSignIn()).toEqual({ kind: 'cancelled' })
  })

  it('signOut clears the session', async () => {
    const { caller, session } = await authRig({}, seeded())
    await caller.auth.signOut()
    expect(session.token()).toBeNull()
    expect(await caller.auth.status()).toEqual({ viewer: null })
  })
})

describe('github', () => {
  it('lists repos, pushable ones flagged', async () => {
    const { caller } = await authRig(
      {
        '/user/repos': [
          { body: [ghRepo(), ghRepo({ full_name: 'a/ro', permissions: { push: false } })] },
        ],
      },
      seeded(),
    )

    const repos = await caller.github.repos()
    expect(repos.map((r) => [r.remote, r.canPush])).toEqual([
      [REMOTE, true],
      ['a/ro', false],
    ])
  })

  it('returns collaborators with the repo visibility', async () => {
    // A vault silently becoming public is the highest-severity thing that can
    // happen to it, and the members panel is the only surface that would show
    // it — so it arrives with the members, not from a second call the UI can
    // forget to make.
    const { caller } = await authRig(
      {
        [`/repos/${REMOTE}`]: [{ body: ghRepo({ visibility: 'public', private: false }) }],
        [`/repos/${REMOTE}/collaborators`]: [
          {
            body: [
              {
                login: 'octocat',
                id: 1,
                avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
                permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
              },
            ],
          },
        ],
      },
      seeded(),
    )

    expect(await caller.github.collaborators({ remote: REMOTE })).toEqual({
      visibility: 'public',
      collaborators: [
        {
          accountId: 1,
          login: 'octocat',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
          permission: 'write',
        },
      ],
    })
  })

  it('opens the repo collaborator settings page', async () => {
    // FR-11: Holi does not implement invitation, it deep-links to the flow
    // that does.
    const { caller, openExternal } = await authRig({}, seeded())
    await caller.github.openCollaboratorSettings({ remote: REMOTE })
    expect(openExternal).toHaveBeenCalledWith(`https://github.com/${REMOTE}/settings/access`)
  })

  it('refuses to open a settings page for a remote that is not owner/repo', async () => {
    // The value is interpolated into a URL. Validate before, not after.
    const { caller, openExternal } = await authRig({}, seeded())
    await expect(
      caller.github.openCollaboratorSettings({ remote: '../../evil' }),
    ).rejects.toThrow()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('surfaces saml-required with its url', async () => {
    // "403 Forbidden" sends the user nowhere. The authorization URL is the
    // whole difference between a dead end and a fix.
    const { caller } = await authRig(
      {
        '/user/repos': [
          {
            status: 403,
            body: { message: 'Resource protected by organization SAML enforcement' },
            headers: {
              'x-github-sso':
                'required; url=https://github.com/orgs/syv-ai/sso?authorization_request=AB4CkQ',
            },
          },
        ],
      },
      seeded(),
    )

    await expect(caller.github.repos()).rejects.toThrow(
      /https:\/\/github\.com\/orgs\/syv-ai\/sso/,
    )
  })

  it('fails clearly when signed out', async () => {
    // UNAUTHORIZED before a request goes out — not an unauthenticated call
    // that 401s its way to the same place by accident.
    const { caller } = await authRig({})
    await expect(caller.github.repos()).rejects.toThrow(/not signed in/)
  })

  it('creates a private vault repo', async () => {
    const { caller } = await authRig(
      { '/orgs/syv-ai/repos': [{ status: 201, body: ghRepo() }] },
      seeded(),
    )
    expect(await caller.github.createRepo({ name: '1brain', owner: 'syv-ai' })).toMatchObject({
      remote: REMOTE,
      private: true,
    })
  })

  it('lists the orgs a new vault could live under', async () => {
    const { caller } = await authRig(
      { '/user/orgs': [{ body: [{ login: 'syv-ai', avatar_url: 'https://a.test/9.png' }] }] },
      seeded(),
    )
    expect(await caller.github.orgs()).toEqual([
      { login: 'syv-ai', avatarUrl: 'https://a.test/9.png' },
    ])
  })
})
