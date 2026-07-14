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

async function rig(tasks: Task[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'holi-tp-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const workRoot = join(dir, 'work')
  await mkdir(workRoot, { recursive: true })

  let live = [...tasks]
  const api: TaskProjectorApi = {
    listTasks: async () => live,
    listFolders: async () => FOLDERS,
  }
  const store = new ProjectionStore(join(dir, 'projection'))
  const projector = new TaskProjector({
    workRoot,
    store,
    api,
    notePathFor: (docId) => (docId === NOTE ? 'meetings/kickoff.md' : undefined),
    log: () => {},
  })

  const read = (rel: string) => readFile(join(workRoot, rel), 'utf8')
  const exists = (rel: string) => existsSync(join(workRoot, rel))
  return {
    workRoot,
    store,
    projector,
    read,
    exists,
    setLive: (next: Task[]) => void (live = next),
    /** A fresh projector over the same disk + store — i.e. an app restart. */
    restart: () =>
      new TaskProjector({
        workRoot,
        store,
        api,
        notePathFor: (docId) => (docId === NOTE ? 'meetings/kickoff.md' : undefined),
        log: () => {},
      }),
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

  it('leaves a hand-written file with no id alone — that is a create, not an orphan', async () => {
    const r = await rig([])
    await r.projector.start()
    await mkdir(join(r.workRoot, 'tasks'), { recursive: true })
    await writeFile(
      join(r.workRoot, 'tasks/brand-new.md'),
      '---\ntitle: Written by the agent\n---\n\nBody.\n',
      'utf8',
    )

    await r.restart().start()

    // pruning this would silently eat the agent's new task
    expect(r.exists('tasks/brand-new.md')).toBe(true)
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
