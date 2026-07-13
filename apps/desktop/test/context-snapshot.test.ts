import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Task } from '@holi/shared'
import { ContextSnapshot, CONTEXT_FILE } from '../src/main/agent/context-snapshot'

const NOTE_ID = 'doc-1'
const NOTE_PATH = 'notes/plan.md'
const OTHER_ID = 'doc-2'
const OTHER_PATH = 'notes/other.md'

const dirs: string[] = []
const snapshots: ContextSnapshot[] = []
afterEach(async () => {
  for (const s of snapshots.splice(0)) s.stop()
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    vaultId: 'v1',
    title: 'Draft proposal',
    status: 'todo',
    tags: [],
    related: [{ kind: 'note', id: NOTE_ID }],
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

interface Rig {
  snapshot: ContextSnapshot
  root: string
  read(): Promise<any>
  taskFetches: number
}

async function rig(opts: { tasks?: Task[]; backrefs?: Array<{ srcDocId: string; occurrences: number }>; fail?: boolean } = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'holi-ctx-'))
  dirs.push(root)
  let taskFetches = 0
  const snapshot = new ContextSnapshot({
    workRoot: root,
    listTasks: async () => {
      taskFetches += 1
      if (opts.fail) throw new Error('server down')
      return opts.tasks ?? []
    },
    backrefs: async () => {
      if (opts.fail) throw new Error('server down')
      return opts.backrefs ?? []
    },
    docIdForPath: (p) => (p === NOTE_PATH ? NOTE_ID : p === OTHER_PATH ? OTHER_ID : null),
    pathForDocId: (id) => (id === NOTE_ID ? NOTE_PATH : id === OTHER_ID ? OTHER_PATH : null),
    debounceMs: 20,
  })
  snapshots.push(snapshot)
  return {
    snapshot,
    root,
    read: async () => JSON.parse(await readFile(join(root, CONTEXT_FILE), 'utf8')),
    get taskFetches() {
      return taskFetches
    },
  }
}

describe('ContextSnapshot', () => {
  it('writes focus, related non-done tasks, and backref paths', async () => {
    const r = await rig({
      tasks: [
        task(),
        task({ id: 't2', title: 'Done one', status: 'done' }), // done: excluded
        task({ id: 't3', title: 'Unrelated', related: [] }), // not linked: excluded
        task({ id: 't4', title: 'With due', due: '2026-07-20' }),
      ],
      backrefs: [
        { srcDocId: OTHER_ID, occurrences: 2 },
        { srcDocId: 'unmapped', occurrences: 1 }, // no path: dropped
      ],
    })
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH, OTHER_PATH] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.openPaths).toEqual([NOTE_PATH, OTHER_PATH])
    expect(ctx.relatedTasks).toEqual([
      { id: 't1', title: 'Draft proposal', status: 'todo' },
      { id: 't4', title: 'With due', status: 'todo', due: '2026-07-20' },
    ])
    expect(ctx.backrefPaths).toEqual([OTHER_PATH])
    expect(typeof ctx.updatedAt).toBe('string')
  })

  it('writes an empty context when nothing is focused (no server calls needed)', async () => {
    const r = await rig({ tasks: [task()] })
    r.snapshot.setFocus({ focusedPath: null, openPaths: [] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBeNull()
    expect(ctx.relatedTasks).toEqual([])
    expect(ctx.backrefPaths).toEqual([])
    expect(r.taskFetches).toBe(0)
  })

  it('degrades to empty sections when the server fails — the hook must never block', async () => {
    const r = await rig({ fail: true })
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [NOTE_PATH] })
    await r.snapshot.flush()

    const ctx = await r.read()
    expect(ctx.focusedPath).toBe(NOTE_PATH)
    expect(ctx.relatedTasks).toEqual([])
    expect(ctx.backrefPaths).toEqual([])
  })

  it('debounces a burst of task events into a single fetch', async () => {
    const r = await rig({ tasks: [task()] })
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await r.snapshot.flush()
    const afterFocus = r.taskFetches

    for (let i = 0; i < 5; i++) r.snapshot.onTasksEvent()
    await r.snapshot.flush()

    expect(r.taskFetches).toBe(afterFocus + 1)
    expect((await r.read()).relatedTasks).toHaveLength(1)
  })

  it('rewrites the file when focus moves to another note', async () => {
    const r = await rig({ tasks: [task()] })
    r.snapshot.setFocus({ focusedPath: NOTE_PATH, openPaths: [] })
    await r.snapshot.flush()
    expect((await r.read()).relatedTasks).toHaveLength(1)

    r.snapshot.setFocus({ focusedPath: OTHER_PATH, openPaths: [] })
    await r.snapshot.flush()
    const ctx = await r.read()
    expect(ctx.focusedPath).toBe(OTHER_PATH)
    expect(ctx.relatedTasks).toEqual([]) // t1 is linked to NOTE_PATH, not this one
  })
})
