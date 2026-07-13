/**
 * The agent's 7-op surface (spec §McpServer). Every op proxies to the server
 * through the main-process ServerClient — i.e. with the *user's* session token,
 * so membership gating stays server-side and the agent can never outrank the
 * user.
 *
 * The agent speaks vault-relative note **paths**; the server speaks note docId
 * UUIDs. These ops translate in both directions so note UUIDs never leak into
 * the agent's view (plan decision 3).
 */
import type { RelatedRef, Task } from '@holi/shared'
import type { ServerClient } from '../server-client'

export interface AgentOp {
  name: string
  description: string
  /** Plain JSON Schema — handed to the CLI verbatim in tools/list. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  run(args: Record<string, unknown>): Promise<unknown>
}

export interface AgentOpsDeps {
  client: ServerClient
  vaultId: string
  docIdForPath(rel: string): string | null
  pathForDocId(docId: string): string | null
}

/** A related ref as the agent sees it: note refs carry a path, not a UUID. */
interface AgentRef {
  kind: RelatedRef['kind']
  id: string
}

const STATUS = ['todo', 'doing', 'done']

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

export function buildOps(deps: AgentOpsDeps): AgentOp[] {
  const { client, vaultId, docIdForPath, pathForDocId } = deps

  /** Agent ref → server ref: note refs arrive as paths, leave as docIds. */
  const toServerRef = (ref: AgentRef): RelatedRef => {
    if (ref.kind !== 'note') return { kind: ref.kind, id: ref.id }
    const docId = docIdForPath(ref.id)
    if (!docId) throw new Error(`unknown note path: ${ref.id}`)
    return { kind: 'note', id: docId }
  }

  /** Server task → agent view: note refs gain the path they were named by. */
  const render = (task: Task) => ({
    ...task,
    related: task.related.map((ref) =>
      ref.kind === 'note' ? { ...ref, path: pathForDocId(ref.id) ?? undefined } : ref,
    ),
  })

  const relatedRefSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['note', 'task', 'email', 'event'] },
      id: {
        type: 'string',
        description: 'For kind "note", the vault-relative path (e.g. "notes/plan.md"); otherwise the id.',
      },
    },
    required: ['kind', 'id'],
  }

  const taskFieldProps = {
    status: { type: 'string', enum: STATUS },
    due: { type: 'string', description: 'YYYY-MM-DD' },
    priority: { type: 'string', enum: ['low', 'medium', 'high'] },
    tags: { type: 'array', items: { type: 'string' } },
    reminder: { type: 'string', description: 'Nd | Nw | YYYY-MM-DDTHH:MM' },
    recurrence: {
      type: 'object',
      properties: {
        frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        interval: { type: 'integer', minimum: 1 },
        weekdays: {
          type: 'array',
          items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        },
        endDate: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['frequency', 'interval'],
    },
  }

  /** Pull the task-field subset the agent supplied, resolving note refs. */
  const patchFrom = (args: Record<string, unknown>): Record<string, unknown> => {
    const patch: Record<string, unknown> = {}
    for (const key of ['title', 'due', 'priority', 'tags', 'reminder', 'recurrence'] as const) {
      if (args[key] !== undefined) patch[key] = args[key]
    }
    if (args.related !== undefined) {
      patch.related = (args.related as AgentRef[]).map(toServerRef)
    }
    return patch
  }

  const ops: AgentOp[] = [
    {
      name: 'task_new',
      description:
        'Create a task. Tasks are server records, not files — this is the only way to create one. Note references in `related` take vault-relative paths, not ids.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          ...taskFieldProps,
          related: { type: 'array', items: relatedRefSchema },
        },
        required: ['title'],
      },
      run: async (args) => {
        const title = requireString(args, 'title')
        const { title: _t, ...rest } = args
        const status = args.status === undefined ? {} : { status: args.status }
        const created = await client.tasks.create.mutate({
          vaultId,
          title,
          ...status,
          ...patchFrom(rest),
        } as never)
        return render(created as Task)
      },
    },
    {
      name: 'task_list',
      description:
        'List the vault\'s tasks. The only server-side filter is `status` — fetch the narrowest status set that answers the question, then filter by due date, tags, or priority yourself.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: STATUS } },
      },
      run: async (args) => {
        const filter = args.status ? { status: args.status } : {}
        const tasks = await client.tasks.list.query({ vaultId, filter } as never)
        return (tasks as Task[]).map(render)
      },
    },
    {
      name: 'task_get',
      description: 'Fetch one task by id, including its related notes (rendered with their vault paths).',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
      run: async (args) => {
        const taskId = requireString(args, 'task_id')
        return render((await client.tasks.get.query({ vaultId, taskId } as never)) as Task)
      },
    },
    {
      name: 'task_set',
      description:
        'Update a task. Setting `status: "done"` completes it — for a recurring task the server rolls the due date forward to the next instance, so never create a follow-up task yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          title: { type: 'string' },
          ...taskFieldProps,
          related: { type: 'array', items: relatedRefSchema },
        },
        required: ['task_id'],
      },
      run: async (args) => {
        const taskId = requireString(args, 'task_id')
        const { status, ...rest } = args
        const patch = patchFrom(rest)
        if (status !== undefined && status !== 'done') patch.status = status

        let task: Task | null = null
        if (status === 'done') {
          task = (await client.tasks.complete.mutate({ vaultId, taskId } as never)) as Task
        }
        if (Object.keys(patch).length > 0 || task === null) {
          task = (await client.tasks.update.mutate({ vaultId, taskId, patch } as never)) as Task
        }
        return render(task)
      },
    },
    {
      name: 'task_link',
      description:
        'Link a task to a note, another task, an email, or an event. Pass `remove: true` to unlink instead. Note references take vault-relative paths.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          related: relatedRefSchema,
          remove: { type: 'boolean', description: 'Unlink instead of link.' },
        },
        required: ['task_id', 'related'],
      },
      run: async (args) => {
        const taskId = requireString(args, 'task_id')
        if (!args.related) throw new Error('related is required')
        const related = toServerRef(args.related as AgentRef)
        const call = args.remove === true ? client.tasks.unlink : client.tasks.link
        return render((await call.mutate({ vaultId, taskId, related } as never)) as Task)
      },
    },
    {
      name: 'task_delete',
      description: 'Delete a task permanently.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
      run: async (args) => {
        const taskId = requireString(args, 'task_id')
        await client.tasks.delete.mutate({ vaultId, taskId } as never)
        return { ok: true }
      },
    },
    {
      name: 'note_rename',
      description:
        'Rename or move a note, rewriting every `[[wiki-link]]` to it across the vault. Always use this instead of `mv` — a raw move loses the note\'s identity and breaks its links.',
      inputSchema: {
        type: 'object',
        properties: {
          from_path: { type: 'string', description: 'Current vault-relative path.' },
          to_path: { type: 'string', description: 'New vault-relative path.' },
        },
        required: ['from_path', 'to_path'],
      },
      run: async (args) => {
        const fromPath = requireString(args, 'from_path')
        const toPath = requireString(args, 'to_path')
        const docId = docIdForPath(fromPath)
        if (!docId) throw new Error(`unknown note path: ${fromPath}`)
        await client.notes.rename.mutate({ vaultId, docId, newPath: toPath } as never)
        return { ok: true, path: toPath }
      },
    },
  ]

  return ops.sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
}
