import { describe, expect, it } from 'vitest'
import type { Task } from '@holi/shared'
import { buildOps, type AgentOp } from '../src/main/agent/mcp-ops'
import type { ServerClient } from '../src/main/server-client'

const VAULT = 'v-1'
const NOTE_ID = '11111111-1111-4111-8111-111111111111'
const TASK_ID = '22222222-2222-4222-8222-222222222222'
const NOTE_PATH = 'notes/plan.md'

interface Call {
  path: string
  input: unknown
}

function fakeTask(over: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    vaultId: VAULT,
    title: 'Draft proposal',
    status: 'todo',
    tags: [],
    related: [],
    version: 1,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    ...over,
  }
}

/** tRPC-shaped stub: `client.tasks.create.mutate(input)` etc. */
function fakeClient(result: unknown = fakeTask()) {
  const calls: Call[] = []
  const proc = (path: string) => ({
    query: async (input: unknown) => (calls.push({ path, input }), result),
    mutate: async (input: unknown) => (calls.push({ path, input }), result),
  })
  const client = {
    tasks: {
      list: proc('tasks.list'),
      get: proc('tasks.get'),
      create: proc('tasks.create'),
      update: proc('tasks.update'),
      complete: proc('tasks.complete'),
      link: proc('tasks.link'),
      unlink: proc('tasks.unlink'),
      delete: proc('tasks.delete'),
    },
    notes: { rename: proc('notes.rename') },
  } as unknown as ServerClient
  return { client, calls }
}

function ops(client: ServerClient): Map<string, AgentOp> {
  const list = buildOps({
    client,
    vaultId: VAULT,
    docIdForPath: (p) => (p === NOTE_PATH ? NOTE_ID : null),
    pathForDocId: (id) => (id === NOTE_ID ? NOTE_PATH : null),
  })
  return new Map(list.map((op) => [op.name, op]))
}

describe('buildOps', () => {
  it('exposes exactly the 3 ops that a file write cannot express', () => {
    // task_new / task_get / task_link / task_delete are retired: they are plain
    // file operations on tasks/<slug>-<id>.md now.
    const { client } = fakeClient()
    const names = buildOps({
      client,
      vaultId: VAULT,
      docIdForPath: () => null,
      pathForDocId: () => null,
    }).map((o) => o.name)
    expect(names).toEqual(['note_rename', 'task_list', 'task_set'])
  })

  it('every op declares a description and an object input schema', () => {
    const { client } = fakeClient()
    for (const op of buildOps({ client, vaultId: VAULT, docIdForPath: () => null, pathForDocId: () => null })) {
      expect(op.description.length).toBeGreaterThan(10)
      expect(op.inputSchema.type).toBe('object')
    }
  })

  it('task_list passes the status filter through and enriches note refs with paths', async () => {
    const { client, calls } = fakeClient([fakeTask({ related: [{ kind: 'note', id: NOTE_ID }] })])
    const out = (await ops(client).get('task_list')!.run({ status: 'todo' })) as Array<{
      related: Array<{ kind: string; id: string; path?: string }>
    }>
    expect(calls[0]).toEqual({ path: 'tasks.list', input: { vaultId: VAULT, filter: { status: 'todo' } } })
    expect(out[0]!.related[0]).toEqual({ kind: 'note', id: NOTE_ID, path: NOTE_PATH })
  })

  it('task_list with no filter sends an empty filter', async () => {
    const { client, calls } = fakeClient([])
    await ops(client).get('task_list')!.run({})
    expect(calls[0]!.input).toEqual({ vaultId: VAULT, filter: {} })
  })

  it('task_set with status done routes through tasks.complete (recurrence rolls server-side)', async () => {
    const { client, calls } = fakeClient()
    await ops(client).get('task_set')!.run({ task_id: TASK_ID, status: 'done' })
    expect(calls.map((c) => c.path)).toEqual(['tasks.complete'])
    expect(calls[0]!.input).toEqual({ vaultId: VAULT, taskId: TASK_ID })
  })

  it('task_set with a non-done status is a plain update', async () => {
    const { client, calls } = fakeClient()
    await ops(client).get('task_set')!.run({ task_id: TASK_ID, status: 'doing' })
    expect(calls.map((c) => c.path)).toEqual(['tasks.update'])
    expect(calls[0]!.input).toEqual({ vaultId: VAULT, taskId: TASK_ID, patch: { status: 'doing' } })
  })

  it('task_set requires a task_id and a status — every other field is a file edit', async () => {
    const { client } = fakeClient()
    await expect(ops(client).get('task_set')!.run({ status: 'done' })).rejects.toThrow(
      'task_id is required',
    )
    await expect(ops(client).get('task_set')!.run({ task_id: TASK_ID })).rejects.toThrow(
      'status is required',
    )
  })

  it('note_rename resolves from_path to a docId and passes the new path', async () => {
    const { client, calls } = fakeClient({})
    const out = await ops(client).get('note_rename')!.run({ from_path: NOTE_PATH, to_path: 'notes/final.md' })
    expect(calls[0]).toEqual({
      path: 'notes.rename',
      input: { vaultId: VAULT, docId: NOTE_ID, newPath: 'notes/final.md' },
    })
    expect(out).toEqual({ ok: true, path: 'notes/final.md' })
  })

  it('note_rename rejects an unknown source path and missing args', async () => {
    const { client } = fakeClient()
    await expect(
      ops(client).get('note_rename')!.run({ from_path: 'gone.md', to_path: 'x.md' }),
    ).rejects.toThrow('unknown note path: gone.md')
    await expect(ops(client).get('note_rename')!.run({ from_path: NOTE_PATH })).rejects.toThrow(
      'to_path is required',
    )
  })
})
