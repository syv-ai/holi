import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseTaskFile } from '@holi/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createVaultHost, type VaultHost } from '../src/main/vault/active-vault'
import { makeClone, makeNonVaultRemote, makeRemote, plainGit } from './helpers/git-fixtures'
import { createRouter } from '../src/main/router'
import { resolveTypstBin } from '../src/main/pdf/typst-bin'
import plainTemplateTyp from '../src/main/agent/templates/plain/template.typ?raw'

const exec = promisify(execFile)
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

/**
 * A session over a real store. Signed out unless `auth` is given — most suites
 * do not care, and the ones that do stub `session.api` directly rather than
 * scripting a network.
 */
async function idleSession(base: string, auth?: StoredAuth): Promise<GitHubSession> {
  const store = new TokenStore(join(base, 'github-auth.enc'), storage)
  if (auth) await store.write(auth)
  return GitHubSession.load({
    store,
    fetch: (() => {
      throw new Error('no network in this rig')
    }) as unknown as typeof globalThis.fetch,
  })
}

const hosts: VaultHost[] = []
afterAll(async () => {
  for (const h of hosts) await h.close().catch(() => {})
})

async function rig(files: Record<string, string> = {}, auth?: StoredAuth) {
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
  const session = await idleSession(base, auth)
  // Timers are effectively off: these tests drive the vault explicitly, and a
  // background loop firing mid-assertion is noise, not coverage. The loop's own
  // behaviour is tested in active-vault.test.ts.
  const host = createVaultHost({
    registry,
    onSnapshot: () => {},
    onSyncState: () => {},
    timings: { pullIntervalMs: 3_600_000, healIntervalMs: 3_600_000, commitQuietMs: 3_600_000 },
  })
  hosts.push(host)
  const caller = createRouter({
    registry,
    session,
    host,
    vaultRoot: join(base, 'Holi'),
    openExternal: async () => {},
    downloadsDir: join(base, 'Downloads'),
    typstCacheDir: join(base, 'typst'),
    now: () => '2026-07-21T12:00:00Z',
    today: () => TODAY,
  }).createCaller({})
  return { caller, root, registry, host, session, base }
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

  it('open makes the vault active, so the loop is running behind the snapshot', async () => {
    const { caller, host } = await rig({ 'a.md': '# A\n' })
    await caller.vaults.open({ remote: REMOTE })
    expect(host.active()?.remote).toBe(REMOTE)
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

  /**
   * The write-then-read contract, and the whole of the "new note does nothing"
   * bug. The renderer creates a note and immediately re-reads the snapshot to
   * find it; `vaults.snapshot` answers from `ActiveVault`'s cache, which used to
   * be refreshed only by the filesystem watcher — and chokidar drops `add`
   * events on macOS (see watcher.ts), so the note stayed invisible until the
   * 30-second heal tick. Creating it again then failed with "already exists" for
   * a file the user could not see.
   *
   * The watcher is deliberately still a hint here: these assertions run well
   * inside its debounce, so only an explicit refresh can make them pass.
   */
  it('makes a created note visible to the very next snapshot read', async () => {
    const { caller } = await rig({ 'a.md': '# A\n' })
    await caller.vaults.open({ remote: REMOTE })
    await caller.notes.create({ remote: REMOTE, path: 'fresh.md', text: '# Fresh\n' })
    const snap = await caller.vaults.snapshot({ remote: REMOTE })
    expect(snap.docs.map((d) => d.path).sort()).toEqual(['a.md', 'fresh.md'])
  })

  it('makes a deleted note gone from the very next snapshot read', async () => {
    const { caller } = await rig({ 'a.md': '# A\n', 'b.md': '# B\n' })
    await caller.vaults.open({ remote: REMOTE })
    await caller.notes.delete({ remote: REMOTE, path: 'b.md' })
    const snap = await caller.vaults.snapshot({ remote: REMOTE })
    expect(snap.docs.map((d) => d.path)).toEqual(['a.md'])
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

  it('backrefs names each referrer and its count', async () => {
    const { caller } = await rig({
      'a.md': '[[b.md]] and [[b.md|Alias]]',
      'c.md': 'one [[b.md]] here',
      'b.md': 'the target',
    })
    expect(await caller.notes.backrefs({ remote: REMOTE, path: 'b.md' })).toEqual([
      { path: 'a.md', count: 2 },
      { path: 'c.md', count: 1 },
    ])
  })

  it('rename moves the file and rewrites inbound links, leaving task chips alone', async () => {
    const { caller, root } = await rig({
      'old.md': 'the body',
      'ref.md': 'see [[old.md]] and [[old.md|Alias]] and [[task:t1]]',
    })
    const result = await caller.notes.rename({ remote: REMOTE, from: 'old.md', to: 'sub/new.md' })

    expect(result).toEqual({ rewritten: [{ path: 'ref.md', count: 2 }] })
    await expect(caller.notes.read({ remote: REMOTE, path: 'old.md' })).rejects.toThrow()
    expect(await readFile(join(root, 'sub/new.md'), 'utf8')).toBe('the body')
    expect(await readFile(join(root, 'ref.md'), 'utf8')).toBe(
      'see [[sub/new.md]] and [[sub/new.md|Alias]] and [[task:t1]]',
    )
  })

  it('rename refuses to clobber an existing destination', async () => {
    const { caller } = await rig({ 'old.md': 'a', 'taken.md': 'b' })
    await expect(
      caller.notes.rename({ remote: REMOTE, from: 'old.md', to: 'taken.md' }),
    ).rejects.toThrow(/already exists/)
  })

  it('move renames many files and rewrites inbound links in one pass', async () => {
    const { caller, root } = await rig({
      'projects/a.md': 'A',
      'projects/b.md': 'B',
      'index.md': '[[projects/a.md]] and [[projects/b.md]]',
    })
    await caller.notes.move({
      remote: REMOTE,
      moves: [
        { from: 'projects/a.md', to: 'work/a.md' },
        { from: 'projects/b.md', to: 'work/b.md' },
      ],
    })
    expect(await readFile(join(root, 'work/a.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, 'index.md'), 'utf8')).toBe('[[work/a.md]] and [[work/b.md]]')
  })

  it('move refuses to clobber a destination outside the moved set', async () => {
    const { caller } = await rig({ 'a.md': 'a', 'taken.md': 'b' })
    await expect(
      caller.notes.move({ remote: REMOTE, moves: [{ from: 'a.md', to: 'taken.md' }] }),
    ).rejects.toThrow(/already exists/)
  })

  it('move allows a destination that is itself a source in the same batch (a swap-shaped chain)', async () => {
    const { caller, root } = await rig({ 'a.md': 'A', 'b.md': 'B' })
    await caller.notes.move({
      remote: REMOTE,
      moves: [
        { from: 'a.md', to: 'b.md' },
        { from: 'b.md', to: 'c.md' },
      ],
    })
    expect(await readFile(join(root, 'b.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, 'c.md'), 'utf8')).toBe('B')
  })

  it('copy duplicates without rewriting links, and refuses to clobber', async () => {
    const { caller, root } = await rig({ 'a.md': 'body [[x.md]]', 'taken.md': 'mine' })
    const result = await caller.notes.copy({ remote: REMOTE, copies: [{ from: 'a.md', to: 'dup.md' }] })
    expect(result).toEqual({ copied: ['dup.md'] })
    expect(await readFile(join(root, 'dup.md'), 'utf8')).toBe('body [[x.md]]')
    await expect(
      caller.notes.copy({ remote: REMOTE, copies: [{ from: 'a.md', to: 'taken.md' }] }),
    ).rejects.toThrow(/already exists/)
  })

  it('copy reports a missing source rather than writing an empty file', async () => {
    const { caller } = await rig()
    await expect(
      caller.notes.copy({ remote: REMOTE, copies: [{ from: 'ghost.md', to: 'dup.md' }] }),
    ).rejects.toThrow(/ghost/)
  })

  it('deleteMany removes every path in one call', async () => {
    const { caller } = await rig({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' })
    await caller.notes.deleteMany({ remote: REMOTE, paths: ['a.md', 'b.md'] })
    await expect(caller.notes.read({ remote: REMOTE, path: 'a.md' })).rejects.toThrow()
    await expect(caller.notes.read({ remote: REMOTE, path: 'b.md' })).rejects.toThrow()
    expect(await caller.notes.read({ remote: REMOTE, path: 'c.md' })).toBe('C')
  })

  it('backrefsMany names external referrers and excludes links inside the set', async () => {
    const { caller } = await rig({
      'p/a.md': 'links [[p/b.md]]',
      'p/b.md': 'other',
      'outside.md': '[[p/a.md]] and [[p/b.md]]',
    })
    expect(await caller.notes.backrefsMany({ remote: REMOTE, paths: ['p/a.md', 'p/b.md'] })).toEqual([
      { path: 'outside.md', count: 2 },
    ])
  })

  it('the batch procedures guard paths just like the single ones', async () => {
    const { caller } = await rig()
    await expect(
      caller.notes.move({ remote: REMOTE, moves: [{ from: '../evil.md', to: 'x.md' }] }),
    ).rejects.toThrow()
    await expect(
      caller.notes.deleteMany({ remote: REMOTE, paths: ['../evil.md'] }),
    ).rejects.toThrow()
  })

  it('getOrCreateDaily creates today’s note once, using the local date', async () => {
    const { caller, root } = await rig()
    // The rig pins today to TODAY = 2026-07-21 → stem 21-07-2026.
    expect(await caller.notes.getOrCreateDaily({ remote: REMOTE })).toEqual({
      path: '21-07-2026.md',
      created: true,
    })
    expect(await readFile(join(root, '21-07-2026.md'), 'utf8')).toContain('type: daily-note')
    expect(await caller.notes.getOrCreateDaily({ remote: REMOTE })).toEqual({
      path: '21-07-2026.md',
      created: false,
    })
  })

  it('sweepDaily deletes an untouched prior-day stub', async () => {
    const { caller } = await rig({
      '20-07-2026.md': '---\ntype: daily-note\ndate: 2026-07-20\n---\n\n# 20-07-2026\n\n',
    })
    expect(await caller.notes.sweepDaily({ remote: REMOTE })).toEqual({ archived: 0, deleted: 1 })
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
  const host = createVaultHost({ registry, onSnapshot: () => {}, onSyncState: () => {} })
  hosts.push(host)
  const caller = createRouter({
    registry,
    session,
    host,
    vaultRoot: join(base, 'Holi'),
    openExternal,
    downloadsDir: join(base, 'Downloads'),
    typstCacheDir: join(base, 'typst'),
  }).createCaller({})
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

describe('vaults.add', () => {
  it('clones, seeds, registers and opens', async () => {
    const { caller, host, base } = await rig()
    const origin = await makeRemote()

    const snap = await caller.vaults.add({ remote: 'syv-ai/notes', url: origin })

    // The repo's own content plus the managed files, because seeding happens on
    // the way in rather than at some later activation. The seeded md-to-pdf skill
    // is markdown under .claude/, so — like every managed .md — it scans as a note.
    expect(snap.docs.map((d) => d.path).sort()).toEqual([
      '.claude/skills/md-to-pdf/SKILL.md',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
      'README.md',
    ])
    const entry = (await caller.vaults.list()).find((v) => v.remote === 'syv-ai/notes')
    expect(entry?.path).toBe(join(base, 'Holi', 'syv-ai', 'notes'))
    expect(host.active()?.remote).toBe('syv-ai/notes')
    // Seeded on the way in, so the `.gitignore` is in place before the first
    // commit can carry a machine-local file.
    expect(await readFile(join(entry!.path, '.gitignore'), 'utf8')).toContain('USER.md')
    expect(await readFile(join(entry!.path, 'AGENTS.md'), 'utf8')).toContain('# Agent rules')
  })

  it('refuses to adopt a repo that is not a Holi vault, and registers nothing', async () => {
    // The picker filters to vaults, but a remote can reach this procedure
    // directly. Adopting seeds the clone, so a plain code repo (no `.holi`
    // marker) must be refused before the seed can commit `AGENTS.md`/`.claude/`
    // into it — otherwise the next auto-push corrupts someone's codebase.
    const { caller, base } = await rig()
    const origin = await makeNonVaultRemote()

    await expect(
      caller.vaults.add({ remote: 'syv-ai/just-code', url: origin }),
    ).rejects.toThrow(/not a Holi vault/)

    expect((await caller.vaults.list()).map((v) => v.remote)).toEqual([REMOTE])
    // The clone made to inspect it is removed, so a refused adopt leaves nothing.
    await expect(
      readFile(join(base, 'Holi', 'syv-ai', 'just-code', 'README.md'), 'utf8'),
    ).rejects.toThrow()
  })

  it('adopts a clone that is already at the managed path', async () => {
    const { caller, base } = await rig()
    const origin = await makeRemote()
    const dest = join(base, 'Holi', 'syv-ai', 'notes')
    await mkdir(join(base, 'Holi', 'syv-ai'), { recursive: true })
    await exec('git', ['clone', origin, dest])
    await writeFile(join(dest, 'unpublished.md'), 'never left this machine\n', 'utf8')

    await caller.vaults.add({ remote: 'syv-ai/notes', url: origin })

    expect(await readFile(join(dest, 'unpublished.md'), 'utf8')).toBe('never left this machine\n')
  })

  it('refuses an occupied path that is not ours, and registers nothing', async () => {
    const { caller, base } = await rig()
    const dest = join(base, 'Holi', 'syv-ai', 'notes')
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'someones-work.txt'), 'do not delete me\n', 'utf8')

    await expect(
      caller.vaults.add({ remote: 'syv-ai/notes', url: await makeRemote() }),
    ).rejects.toThrow(/not a Holi clone/)

    expect((await caller.vaults.list()).map((v) => v.remote)).toEqual([REMOTE])
    expect(await readFile(join(dest, 'someones-work.txt'), 'utf8')).toBe('do not delete me\n')
  })

  it('refuses a malformed remote', async () => {
    const { caller } = await rig()
    await expect(caller.vaults.add({ remote: '../../etc' })).rejects.toThrow()
  })

  it('does not register a vault whose clone failed', async () => {
    // A half-registered vault is one the switcher can never open.
    const { caller } = await rig()
    await expect(
      caller.vaults.add({ remote: 'syv-ai/notes', url: '/nowhere/at/all.git' }),
    ).rejects.toThrow()
    expect((await caller.vaults.list()).map((v) => v.remote)).toEqual([REMOTE])
  })
})

describe('vaults.create', () => {
  it('creates the repo, seeds it, commits and pushes', async () => {
    const { caller, session, base } = await rig({}, seeded())
    const origin = await makeRemote()
    vi.spyOn(session.api, 'createRepo').mockResolvedValue({
      remote: 'syv-ai/fresh',
      private: true,
      visibility: 'private',
      pushedAt: '2026-07-22T00:00:00Z',
      defaultBranch: 'main',
      canPush: true,
      owner: { login: 'syv-ai', kind: 'org' },
      isVault: true,
    })
    const markVault = vi.spyOn(session.api, 'markVault').mockResolvedValue()

    const snap = await caller.vaults.create({ name: 'fresh', owner: 'syv-ai', url: origin })

    expect(session.api.createRepo).toHaveBeenCalledWith({ name: 'fresh', owner: 'syv-ai' })
    // The new repo is stamped a vault, so it reads as one and passes the guard.
    expect(markVault).toHaveBeenCalledWith('syv-ai/fresh')
    expect(snap.docs.map((d) => d.path).sort()).toContain('AGENTS.md')
    // FR-8: seeded, committed AND pushed, so the vault exists for everyone else.
    // The push is automatic (open-drain + the explicit kick in vaults.create),
    // and can land a moment after create() returns — so poll origin/main rather
    // than assuming it is there the instant the mutation resolves.
    const dest = join(base, 'Holi', 'syv-ai', 'fresh')
    expect(await plainGit(dest, ['status', '--porcelain'])).toBe('')
    let pushed = false
    for (let i = 0; i < 100 && !pushed; i++) {
      pushed = (await plainGit(dest, ['rev-list', '--count', 'origin/main']).catch(() => '0')) !== '0'
      if (!pushed) await new Promise((r) => setTimeout(r, 20))
    }
    expect(pushed).toBe(true)
  })

  it('creates under the personal account via /user/repos, not the org endpoint', async () => {
    // Regression: the owner picker defaults to the signed-in user, but GitHub
    // has no "create under another user" — only `/user/repos` (no owner) or
    // `/orgs/{org}/repos`. Passing the viewer's own login as `owner` used to hit
    // the org endpoint and 404. The router must collapse a self-owner to
    // undefined so a personal-account vault can be created at all.
    const { caller, session } = await rig({}, seeded())
    const origin = await makeRemote()
    vi.spyOn(session.api, 'createRepo').mockResolvedValue({
      remote: 'nthomsencph/fresh',
      private: true,
      visibility: 'private',
      pushedAt: '2026-07-22T00:00:00Z',
      defaultBranch: 'main',
      canPush: true,
      owner: { login: 'nthomsencph', kind: 'user' },
      isVault: true,
    })
    vi.spyOn(session.api, 'markVault').mockResolvedValue()

    await caller.vaults.create({ name: 'fresh', owner: 'nthomsencph', url: origin })

    expect(session.api.createRepo).toHaveBeenCalledWith({ name: 'fresh', owner: undefined })
  })
})

describe('sync', () => {
  it('reports the active vault’s state', async () => {
    const { caller, host, base } = await rig()
    await caller.vaults.add({ remote: 'syv-ai/notes', url: await makeRemote() })
    expect(host.active()).not.toBeNull()

    const state = await caller.sync.state()
    // Resting ahead>0 is not surfaced now that push is automatic — a freshly
    // added vault settles at up-to-date (or, briefly, pulling on the open fetch).
    expect(['up-to-date', 'pulling']).toContain(state.kind)
    expect(base).toBeTruthy()
  })

  it('commitNow commits the working tree', async () => {
    const { caller, base } = await rig()
    await caller.vaults.add({ remote: 'syv-ai/notes', url: await makeRemote() })
    const dest = join(base, 'Holi', 'syv-ai', 'notes')

    // Commit the seed first, so the next commit is about the note alone.
    await caller.sync.commitNow()

    await caller.notes.create({ remote: 'syv-ai/notes', path: 'fresh.md', text: '# Fresh\n' })
    await caller.sync.commitNow()

    expect(await plainGit(dest, ['status', '--porcelain'])).toBe('')
    expect(await plainGit(dest, ['log', '-1', '--format=%s'])).toBe('Update fresh.md')
  })

  it('pushNow sends local commits to the remote', async () => {
    const { caller, base } = await rig()
    const origin = await makeRemote()
    await caller.vaults.add({ remote: 'syv-ai/notes', url: origin })
    const dest = join(base, 'Holi', 'syv-ai', 'notes')

    await caller.notes.create({ remote: 'syv-ai/notes', path: 'ship.md', text: '# Ship\n' })
    await caller.sync.commitNow()
    expect(await caller.sync.pushNow()).toEqual({ ok: true })

    // Wait until dest's commits are all on origin (nothing ahead) before cloning
    // the checker — the explicit pushNow can no-op if the seed's open-drain push
    // is still in flight, and the coalescer's retry lands a beat later.
    for (let i = 0; i < 200; i++) {
      const ahead = await plainGit(dest, ['rev-list', '--count', 'origin/main..HEAD']).catch(() => '1')
      if (ahead === '0') break
      await new Promise((r) => setTimeout(r, 20))
    }

    const check = await makeClone(origin, 'check')
    expect(await readFile(join(check, 'ship.md'), 'utf8')).toBe('# Ship\n')
    expect(dest).toBeTruthy()
  })

  it('pushNow leaves a conflicting divergence in the conflict state, pushing nothing', async () => {
    // FR-15. A non-fast-forward push recovers by pulling; a real conflict routes
    // to the reconcile path, and the user's work stays local and intact.
    const { caller, base } = await rig()
    const origin = await makeRemote()
    await caller.vaults.add({ remote: 'syv-ai/notes', url: origin })
    const dest = join(base, 'Holi', 'syv-ai', 'notes')

    // Push is automatic now, so the vault's seed reaches origin on its own — wait
    // until it has (nothing left ahead) before the teammate branches, or the
    // seed's push races the teammate's and one of them is rejected non-ff.
    await caller.sync.commitNow()
    await caller.sync.pushNow()
    for (let i = 0; i < 200; i++) {
      const ahead = await plainGit(dest, ['rev-list', '--count', 'origin/main..HEAD']).catch(() => '1')
      if (ahead === '0') break
      await new Promise((r) => setTimeout(r, 20))
    }

    const teammate = await makeClone(origin, 'teammate')
    await writeFile(join(teammate, 'README.md'), '# Theirs\n', 'utf8')
    await plainGit(teammate, ['add', '-A'])
    await plainGit(teammate, ['commit', '-m', 'theirs'])
    await plainGit(teammate, ['push', 'origin', 'main'])

    await caller.notes.write({ remote: 'syv-ai/notes', path: 'README.md', text: '# Ours\n' })
    await caller.sync.commitNow()

    await caller.sync.pushNow()
    expect(await caller.sync.state()).toEqual({ kind: 'conflict', paths: ['README.md'] })
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('# Ours\n')
  })

  it('refuses when no vault is active, rather than dereferencing null', async () => {
    const { caller } = await rig()
    await expect(caller.sync.state()).rejects.toThrow(/no vault is open/)
    await expect(caller.sync.commitNow()).rejects.toThrow(/no vault is open/)
    await expect(caller.sync.pushNow()).rejects.toThrow(/no vault is open/)
  })
})

describe('pdf', () => {
  const TEMPLATE_FILES = {
    '.holi/templates/plain/template.json': JSON.stringify({
      name: 'Plain',
      description: 'Clean.',
      fields: [
        { key: 'date', label: 'Date', required: false },
        { key: 'recipient', label: 'Recipient', required: true },
      ],
    }),
    '.holi/templates/plain/template.typ': '#let doc(p, meta: (:), assets: "") = []',
  }

  it('templates returns each template with its declared fields', async () => {
    const { caller } = await rig(TEMPLATE_FILES)
    expect(await caller.pdf.templates({ remote: REMOTE })).toEqual([
      {
        name: 'Plain',
        slug: 'plain',
        description: 'Clean.',
        fields: [
          { key: 'date', label: 'Date', type: 'text', required: false },
          { key: 'recipient', label: 'Recipient', type: 'text', required: true },
        ],
        warnings: [],
      },
    ])
  })

  it('render rejects a meta value that is not a string', async () => {
    const { caller } = await rig({ ...TEMPLATE_FILES, 'note.md': '# Hi\n' })
    await expect(
      caller.pdf.render({
        remote: REMOTE,
        path: 'note.md',
        template: 'plain',
        meta: { date: 5 } as never,
      }),
    ).rejects.toThrow(/meta/)
  })

  it('render writes to the given outPath and threads meta through (needs typst)', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst — skip, don't fail
    const { caller, base } = await rig({
      '.holi/templates/plain/template.json': JSON.stringify({
        name: 'Plain',
        fields: [{ key: 'date', label: 'Date', type: 'date', required: false }],
      }),
      '.holi/templates/plain/template.typ': plainTemplateTyp,
      'note.md': '---\ntitle: T\n---\n\n## Heading\n\nBody.\n',
    })
    const outPath = join(base, 'chosen.pdf')
    const { pdfPath } = await caller.pdf.render({
      remote: REMOTE,
      path: 'note.md',
      template: 'plain',
      outPath,
      meta: { date: '2026-07-26', recipient: 'ACME' },
    })
    expect(pdfPath).toBe(outPath)
    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})
