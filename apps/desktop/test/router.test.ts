import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskFile } from '@holi/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createRouter } from '../src/main/router'
import { VaultRegistry } from '../src/main/vault/registry'

const REMOTE = 'syv-ai/1brain'
const TODAY = '2026-07-21'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

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
