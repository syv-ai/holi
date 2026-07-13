/** Per-vault SSE stream off the in-process bus — the subscription surface the
 * bus was built for (spec 2026-07-13-agent-drawer-design §Server). Consumed by
 * the desktop's VaultMirror (docs) + ContextSnapshot (tasks); later the board.
 * Plain SSE (not tRPC subscriptions) so the client can authenticate with a
 * normal Authorization header over fetch. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveVaultRole } from './auth/membership'
import { resolveSession } from './auth/sessions'
import type { Bus, DocsEvent, RemindersEvent, TasksEvent } from './bus'
import type { Db } from './db/client'
import { bearerToken } from './trpc'

const HEARTBEAT_MS = 25_000

export function makeEventsHandler(deps: { db: Db; bus: Bus }) {
  return async (req: IncomingMessage, res: ServerResponse, vaultId: string): Promise<void> => {
    const token = bearerToken(req)
    const user = token ? await resolveSession(deps.db, token) : null
    const role = user ? await resolveVaultRole(deps.db, vaultId, user.id) : null
    if (!role) {
      res.statusCode = user ? 403 : 401
      return void res.end()
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const send = (channel: string, event: unknown) =>
      res.write(`event: ${channel}\ndata: ${JSON.stringify(event)}\n\n`)
    const onDocs = (e: DocsEvent) => void send('docs', e)
    const onTasks = (e: TasksEvent) => void send('tasks', e)
    const onReminders = (e: RemindersEvent) => void send('reminders', e)
    deps.bus.on(`docs:${vaultId}`, onDocs)
    deps.bus.on(`tasks:${vaultId}`, onTasks)
    deps.bus.on(`reminders:${vaultId}`, onReminders)
    const heartbeat = setInterval(() => res.write(':hb\n\n'), HEARTBEAT_MS)
    req.on('close', () => {
      clearInterval(heartbeat)
      deps.bus.off(`docs:${vaultId}`, onDocs)
      deps.bus.off(`tasks:${vaultId}`, onTasks)
      deps.bus.off(`reminders:${vaultId}`, onReminders)
    })
  }
}
