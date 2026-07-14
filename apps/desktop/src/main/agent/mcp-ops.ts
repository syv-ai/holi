/**
 * The agent's 3-op surface (spec §McpServer, prd/tasks.md §Agent integration).
 * Every op proxies to the server through the main-process ServerClient — i.e.
 * with the *user's* session token, so membership gating stays server-side and
 * the agent can never outrank the user.
 *
 * **The agent works tasks as files.** They are projected into the working copy
 * as `tasks/<slug>-<id>.md`, so creating, reading, editing, finding and deleting
 * a task are ordinary `Write`/`Read`/`Edit`/`Glob`/`rm` operations. There is no
 * op for any of that, because a file write expresses it exactly — `task_new`,
 * `task_get`, `task_link` and `task_delete` were retired for that reason.
 *
 * Only what a file write *cannot* express survives:
 *
 *   task_set    `status: done` in a file is ambiguous for a recurring task — it
 *               cannot distinguish "this instance is done, roll it forward" from
 *               "end the series". The op resolves that intent explicitly. It is
 *               also the sanctioned way to mutate a task without a whole-file
 *               rewrite.
 *   task_list   answering "what's due this week" from files would mean globbing
 *               and parsing every task in the vault. Filtering is a server query;
 *               nothing walks the tasks/ folder to answer a question.
 *   note_rename a raw `mv` loses a note's identity and breaks its wiki-links.
 */
import type { Task } from '@holi/shared'
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

const STATUS = ['todo', 'doing', 'done']

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

export function buildOps(deps: AgentOpsDeps): AgentOp[] {
  const { client, vaultId, docIdForPath, pathForDocId } = deps

  /** Server task → agent view: note refs gain the path they were named by, so a
   * note UUID never leaks into the agent's view (it names notes by path, exactly
   * as the task file does). */
  const render = (task: Task) => ({
    ...task,
    related: task.related.map((ref) =>
      ref.kind === 'note' ? { ...ref, path: pathForDocId(ref.id) ?? undefined } : ref,
    ),
  })

  const ops: AgentOp[] = [
    {
      name: 'task_list',
      description:
        "List the vault's tasks. The only server-side filter is `status` — fetch the narrowest status set that answers the question, then filter by due date, tags, or priority yourself. Use this rather than globbing and parsing `tasks/`.",
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
      name: 'task_set',
      description:
        'Complete a task, or change its status. Setting `status: "done"` completes it — for a recurring task the server rolls the due date forward to the next instance, so never create a follow-up task yourself. Editing any other field is an ordinary `Edit` of the task file; use this op for completion, because writing `status: done` into a file cannot say whether a recurring task should roll forward or end.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', enum: STATUS },
        },
        required: ['task_id', 'status'],
      },
      run: async (args) => {
        const taskId = requireString(args, 'task_id')
        const status = requireString(args, 'status')
        const task =
          status === 'done'
            ? await client.tasks.complete.mutate({ vaultId, taskId } as never)
            : await client.tasks.update.mutate({ vaultId, taskId, patch: { status } } as never)
        return render(task as Task)
      },
    },
    {
      name: 'note_rename',
      description:
        "Rename or move a note, rewriting every `[[wiki-link]]` to it across the vault. Always use this instead of `mv` — a raw move loses the note's identity and breaks its links.",
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
