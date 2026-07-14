import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTaskFile, type Folder, type Task } from '@holi/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectionStore } from '../src/main/vault/projection-store'
import { TaskProjector, type TaskProjectorApi } from '../src/main/vault/task-projector'

const VAULT = '11111111-1111-4111-8111-111111111111'
const T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const T2 = 'bbbbbbbb-2222-4222-8222-222222222222'
const NOTE = 'cccccccc-3333-4333-8333-333333333333'
const AREA = 'dddddddd-4444-4444-8444-444444444444'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function task(over: Partial<Task> = {}): Task {
  return {
    id: T1,
    vaultId: VAULT,
    title: 'Review the Q2 doc',
    status: 'todo',
    tags: [],
    related: [],
    version: 1,
    createdAt: '2026-07-14T00:00:00Z',
    updatedAt: '2026-07-14T00:00:00Z',
    ...over,
  }
}

const FOLDERS: Folder[] = [{ id: AREA, vaultId: VAULT, path: 'projects/q2' }]

class Conflict extends Error {
  code = 'CONFLICT'
}

async function rig(tasks: Task[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-tp-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const workRoot = join(dir, 'work')
  await mkdir(workRoot, { recursive: true })

  // A tiny stand-in for the server: records live here, versions bump on write,
  // and a stale version is rejected exactly as the tRPC router rejects it.
  const live = new Map(tasks.map((t) => [t.id, { ...t }]))
  const calls: string[] = []
  let nextId = 1

  const bump = (t: Task, patch: Partial<Task>): Task => {
    const next = { ...t, ...patch, version: t.version + 1 }
    live.set(t.id, next)
    return next
  }
  const guard = (t: Task, version: number) => {
    if (t.version !== version) throw new Conflict(`stale: ${version} vs ${t.version}`)
  }

  const api: TaskProjectorApi = {
    listTasks: async () => [...live.values()],
    listFolders: async () => FOLDERS,
    getTask: async (id) => live.get(id) ?? null,
    createTask: async (input) => {
      const created: Task = {
        ...task({ id: `eeeeeeee-0000-4000-8000-00000000000${nextId++}` }),
        ...(input as Partial<Task>),
        version: 1,
      }
      live.set(created.id, created)
      calls.push(`create:${created.title}`)
      return created
    },
    updateTask: async (id, patch, version) => {
      // recorded before the guard, so a test can see what was *attempted*
      calls.push(`update:${Object.keys(patch).sort().join(',')}`)
      const t = live.get(id)!
      guard(t, version)
      const clean = Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v]),
      )
      return bump(t, clean as Partial<Task>)
    },
    completeTask: async (id, version) => {
      const t = live.get(id)!
      guard(t, version)
      calls.push('complete')
      // recurring tasks roll forward server-side instead of persisting done
      return t.recurrence
        ? bump(t, { status: 'todo', due: '2030-01-08' })
        : bump(t, { status: 'done' })
    },
    deleteTask: async (id, version) => {
      guard(live.get(id)!, version)
      calls.push('delete')
      live.delete(id)
    },
  }

  const store = new ProjectionStore(join(dir, 'projection'))
  const make = () =>
    new TaskProjector({
      workRoot,
      store,
      api,
      notePathFor: (docId) => (docId === NOTE ? 'meetings/kickoff.md' : undefined),
      docIdForPath: (path) => (path === 'meetings/kickoff.md' ? NOTE : undefined),
      log: () => {},
    })

  const read = (rel: string) => readFile(join(workRoot, rel), 'utf8')
  const exists = (rel: string) => existsSync(join(workRoot, rel))
  const edit = async (rel: string, text: string) => {
    await mkdir(join(workRoot, 'tasks'), { recursive: true })
    await writeFile(join(workRoot, rel), text, 'utf8')
  }
  return {
    workRoot,
    store,
    projector: make(),
    read,
    exists,
    edit,
    calls,
    live,
    setLive: (next: Task[]) => {
      live.clear()
      for (const t of next) live.set(t.id, t)
    },
    /** A fresh projector over the same disk + store — i.e. an app restart. */
    restart: make,
  }
}

describe('TaskProjector — record -> file', () => {
  it('start() writes a file per task and populates the store', async () => {
    const r = await rig([task(), task({ id: T2, title: 'Call the vendor' })])
    await r.projector.start()

    expect(r.exists(`tasks/review-the-q2-doc-${T1}.md`)).toBe(true)
    expect(r.exists(`tasks/call-the-vendor-${T2}.md`)).toBe(true)

    const stored = await r.store.load()
    expect(stored.get(T1)?.rel).toBe(`tasks/review-the-q2-doc-${T1}.md`)
    expect(stored.get(T1)?.version).toBe(1)
  })

  it('omits absent fields rather than emitting nulls, and renders refs as paths', async () => {
    const r = await rig([
      task({
        area: AREA,
        due: '2026-07-20',
        related: [{ kind: 'note', id: NOTE }],
        description: 'The body.',
      }),
    ])
    await r.projector.start()
    const text = await r.read(`tasks/review-the-q2-doc-${T1}.md`)

    expect(text).not.toMatch(/null/)
    expect(text).not.toMatch(/^priority:/m)
    // a folder id / doc id would be unusable to the agent — it can discover neither
    expect(text).toContain('area: projects/q2')
    expect(text).toContain('meetings/kickoff.md')
    expect(text).toContain('The body.')
    expect(parseTaskFile(text).description).toBe('The body.')
  })

  it('an upsert rewrites the file; a delete removes it', async () => {
    const r = await rig([task()])
    await r.projector.start()

    await r.projector.applyTasksEvent({
      type: 'upserted',
      task: task({ status: 'doing', version: 2 }),
    })
    expect(parseTaskFile(await r.read(`tasks/review-the-q2-doc-${T1}.md`)).fields.status).toBe(
      'doing',
    )
    expect((await r.store.load()).get(T1)?.version).toBe(2)

    await r.projector.applyTasksEvent({ type: 'deleted', taskId: T1 })
    expect(r.exists(`tasks/review-the-q2-doc-${T1}.md`)).toBe(false)
    expect((await r.store.load()).has(T1)).toBe(false)
  })

  it('a title change moves the file — old path gone, content right at the new one', async () => {
    const r = await rig([task()])
    await r.projector.start()

    await r.projector.applyTasksEvent({
      type: 'upserted',
      task: task({ title: 'Review the Q3 doc', version: 2 }),
    })

    expect(r.exists(`tasks/review-the-q2-doc-${T1}.md`)).toBe(false)
    const moved = await r.read(`tasks/review-the-q3-doc-${T1}.md`)
    expect(parseTaskFile(moved).fields.title).toBe('Review the Q3 doc')
    expect(parseTaskFile(moved).id).toBe(T1) // the id suffix keeps identity
    expect((await r.store.load()).get(T1)?.rel).toBe(`tasks/review-the-q3-doc-${T1}.md`)
  })

  it('an unchanged record does not rewrite the file (no watcher churn)', async () => {
    const r = await rig([task()])
    await r.projector.start()
    const rel = `tasks/review-the-q2-doc-${T1}.md`
    const before = await r.read(rel)

    // a byte-identical rewrite would fire a spurious watcher event
    await writeFile(join(r.workRoot, rel), before, 'utf8')
    await r.projector.applyTasksEvent({ type: 'upserted', task: task() })
    expect(await r.read(rel)).toBe(before)
  })
})

describe('TaskProjector — start() reconciliation across a restart', () => {
  it('prunes a file the server deleted while we were away', async () => {
    const r = await rig([task()])
    await r.projector.start()
    expect(r.exists(`tasks/review-the-q2-doc-${T1}.md`)).toBe(true)

    // server-side delete happened while this app was closed
    r.setLive([])
    await r.restart().start()

    expect(r.exists(`tasks/review-the-q2-doc-${T1}.md`)).toBe(false)
    expect((await r.store.load()).has(T1)).toBe(false)
  })

  it('never prunes a hand-written file with no id — that is a create, not an orphan', async () => {
    const r = await rig([])
    await r.projector.start()
    await mkdir(join(r.workRoot, 'tasks'), { recursive: true })
    await writeFile(
      join(r.workRoot, 'tasks/brand-new.md'),
      '---\ntitle: Written by the agent\n---\n\nBody.\n',
      'utf8',
    )

    await r.restart().start()

    // pruning this would silently eat the agent's new task; instead it becomes a
    // record and moves to its canonical, id-suffixed name
    expect(r.calls).toContain('create:Written by the agent')
    const created = [...r.live.values()][0]!
    expect(r.exists(`tasks/written-by-the-agent-${created.id}.md`)).toBe(true)
  })

  it('re-materializes a task file the user deleted by hand while the app was closed', async () => {
    const r = await rig([task()])
    await r.projector.start()
    const rel = `tasks/review-the-q2-doc-${T1}.md`
    await rm(join(r.workRoot, rel))

    await r.restart().start()
    expect(r.exists(rel)).toBe(true)
  })
})

const REL = `tasks/review-the-q2-doc-${T1}.md`

describe('TaskProjector — file -> record', () => {
  it('ignores its own write, echoed back by the watcher', async () => {
    const r = await rig([task()])
    await r.projector.start()
    r.calls.length = 0

    await r.projector.onTaskFileEvent('change', REL as never)
    expect(r.calls).toEqual([]) // no mutation — that would be an infinite loop
  })

  it('two writers, different fields, both survive', async () => {
    // The money case. A whole-record write would make one of them lose.
    const r = await rig([task({ priority: 'low' })])
    await r.projector.start()

    // writer 1: the board drags the card to Doing. The push rewrites the file.
    await r.projector.applyTasksEvent({
      type: 'upserted',
      task: { ...r.live.get(T1)!, status: 'doing', version: 2 },
    })
    r.live.set(T1, { ...r.live.get(T1)!, status: 'doing', version: 2 })

    // writer 2: the agent edits ONLY the title, in the file it now sees
    await r.edit(REL, (await r.read(REL)).replace('title: Review the Q2 doc', 'title: Renamed'))
    r.calls.length = 0
    await r.projector.onTaskFileEvent('change', REL as never)

    // only the field that actually changed is sent
    expect(r.calls).toEqual(['update:title'])
    const rec = r.live.get(T1)!
    expect(rec.title).toBe('Renamed') // the agent's edit landed
    expect(rec.status).toBe('doing') // the board's drag survived it
    expect(rec.priority).toBe('low') // and so did everything else
  })

  it('deleting a key from the frontmatter clears the field (not "unmentioned")', async () => {
    const r = await rig([task({ due: '2026-07-20', priority: 'high' })])
    await r.projector.start()

    const text = (await r.read(REL)).replace('due: 2026-07-20\n', '')
    await r.edit(REL, text)
    r.calls.length = 0
    await r.projector.onTaskFileEvent('change', REL as never)

    expect(r.calls).toEqual(['update:due'])
    expect(r.live.get(T1)!.due).toBeUndefined() // it did not silently survive
    expect(r.live.get(T1)!.priority).toBe('high')
  })

  it('the body is the description', async () => {
    const r = await rig([task()])
    await r.projector.start()
    await r.edit(REL, `${await r.read(REL)}\nA fresh description.\n`)
    r.calls.length = 0
    await r.projector.onTaskFileEvent('change', REL as never)

    expect(r.calls).toEqual(['update:description'])
    expect(r.live.get(T1)!.description).toBe('A fresh description.')
  })

  it('status: done routes to complete — the server rolls a recurring task forward', async () => {
    const r = await rig([
      task({ due: '2030-01-01', recurrence: { frequency: 'weekly', interval: 1 } }),
    ])
    await r.projector.start()

    await r.edit(REL, (await r.read(REL)).replace('status: todo', 'status: done'))
    r.calls.length = 0
    await r.projector.onTaskFileEvent('change', REL as never)

    // a file cannot express "roll it" vs "end the series" — that ambiguity is
    // exactly why task_set survives as an op, and why a file `done` completes
    expect(r.calls).toEqual(['complete'])
    const rec = r.live.get(T1)!
    expect(rec.status).toBe('todo') // rolled, not done
    expect(rec.due).toBe('2030-01-08')
    // and the rolled record is written straight back to disk
    expect(parseTaskFile(await r.read(REL)).fields.due).toBe('2030-01-08')
  })

  it('a stale write loses: CONFLICT -> the file is rewritten from truth', async () => {
    const r = await rig([task()])
    await r.projector.start()
    const before = await r.read(REL)

    // the record moves on under the writer (a teammate, a reminder fire)
    r.live.set(T1, { ...r.live.get(T1)!, title: 'Moved on', version: 9 })

    await r.edit(REL, before.replace('title: Review the Q2 doc', 'title: Stale edit'))
    await r.projector.onTaskFileEvent('change', REL as never)

    // the file must never be left in the writer's rejected state — that would
    // silently diverge disk from truth
    const rewritten = await r.read(`tasks/moved-on-${T1}.md`)
    expect(parseTaskFile(rewritten).fields.title).toBe('Moved on')
    expect(r.live.get(T1)!.title).toBe('Moved on')
    expect(r.exists(REL)).toBe(false)
  })

  it('an unparseable write loses and is rewritten from truth', async () => {
    const r = await rig([task()])
    await r.projector.start()

    // the model *will* do this
    await r.edit(REL, '---\ntitle: "unterminated\nstatus: garbage\n---\n')
    await r.projector.onTaskFileEvent('change', REL as never)

    expect(parseTaskFile(await r.read(REL)).fields.title).toBe('Review the Q2 doc')
    expect(r.calls.filter((c) => c.startsWith('update'))).toEqual([])
  })

  it('an unresolvable note path rejects the whole write, not just the ref', async () => {
    const r = await rig([task()])
    await r.projector.start()
    const text = `${await r.read(REL)}`.replace(
      'status: todo',
      'status: todo\nrelated:\n  - { kind: note, path: ghosts/nope.md }',
    )
    await r.edit(REL, text)
    await r.projector.onTaskFileEvent('change', REL as never)

    expect(r.live.get(T1)!.related).toEqual([]) // nothing partially applied
    expect(parseTaskFile(await r.read(REL)).fields.related).toBeUndefined()
  })

  it('rm on a task file deletes the record', async () => {
    const r = await rig([task()])
    await r.projector.start()
    await rm(join(r.workRoot, REL))

    await r.projector.onTaskFileEvent('unlink', REL as never)
    expect(r.calls).toContain('delete')
    expect(r.live.has(T1)).toBe(false)
  })

  it('a title change does not read its own rename as an rm', async () => {
    const r = await rig([task()])
    await r.projector.start()

    // the projector moves the file itself; the watcher reports the old path gone
    await r.projector.applyTasksEvent({
      type: 'upserted',
      task: { ...r.live.get(T1)!, title: 'Renamed', version: 2 },
    })
    r.calls.length = 0
    await r.projector.onTaskFileEvent('unlink', REL as never)

    expect(r.calls).toEqual([]) // NOT a delete — this is our own rename
    expect(r.live.has(T1)).toBe(true)
  })

  it('a well-formed file with no id creates a task and moves it to its canonical path', async () => {
    const r = await rig([])
    await r.projector.start()
    await r.edit('tasks/scratch.md', '---\ntitle: Written by the agent\n---\n\nThe body.\n')

    await r.projector.onTaskFileEvent('add', 'tasks/scratch.md' as never)

    expect(r.calls).toContain('create:Written by the agent')
    const created = [...r.live.values()][0]!
    expect(r.exists('tasks/scratch.md')).toBe(false) // moved to its canonical name
    const canonical = `tasks/written-by-the-agent-${created.id}.md`
    expect(parseTaskFile(await r.read(canonical)).id).toBe(created.id)
    expect(created.description).toBe('The body.')
  })
})

describe('TaskProjector — the restart case (why the store is persisted)', () => {
  it('an edit made while the app was closed lands as a per-field patch', async () => {
    const r = await rig([task({ priority: 'low' })])
    await r.projector.start()

    // app is closed. the agent (or a text editor) edits only the title.
    await r.edit(REL, (await r.read(REL)).replace('title: Review the Q2 doc', 'title: Edited cold'))
    // meanwhile the server changed a field the writer never touched
    r.live.set(T1, { ...r.live.get(T1)!, status: 'doing' })

    r.calls.length = 0
    await r.restart().start()

    // a whole-record overwrite here would clobber `status`; only `title` is sent
    expect(r.calls).toEqual(['update:title'])
    const rec = r.live.get(T1)!
    expect(rec.title).toBe('Edited cold')
    expect(rec.status).toBe('doing') // survived — this is the payoff
    expect(rec.priority).toBe('low')
  })

  it('a task file created while the app was closed becomes a record', async () => {
    const r = await rig([])
    await r.projector.start()
    await r.edit('tasks/offline.md', '---\ntitle: Made offline\n---\n')

    await r.restart().start()
    expect(r.calls).toContain('create:Made offline')
  })
})
