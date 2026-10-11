/**
 * Claude Code's routes on the bridge: how Holi learns when a
 * turn starts and ends, and how full a session's context is, WITHOUT parsing
 * PTY output (docs/features/agent-sessions.md).
 *
 * The seeded `UserPromptSubmit`/`Stop` hooks (`turn-signal.mjs`) POST
 * `/turn/start` and `/turn/end` with the vault's token and the session's job
 * id; the seeded status line POSTs Claude Code's status JSON to `/statusline`
 * the same way. **Every answer is empty**: whatever a Claude Code hook prints
 * is injected into the agent's context.
 *
 * The job id rides beside the vault's standing token, because a background
 * session's environment comes from Claude Code's supervisor rather than from
 * Holi: no per-session bearer can reach it.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import type { RouteServer } from '../provider'

export interface AgentRoutesDeps {
  /** A turn began or ended in one of this vault's background sessions, named
   *  by its short job id. At an end, `pending` is how many background tasks
   *  and session crons Claude Code's Stop input listed, 0 meaning the session
   *  is done rather than paused; null from a script that does not say. */
  onJobTurn(remote: string, jobId: string, active: boolean, pending: number | null): void
  /** A session's status line fired, with Claude Code's status JSON. Holi's
   *  side of a shipped hook must stay backward-compatible, so this route
   *  answers every older script too. */
  onStatus?(remote: string, jobId: string, status: unknown): void
  log?: (msg: string) => void
}

/** A Claude Code job id: eight hex characters, the name of its `jobs/` dir. */
const JOB_ID = /^[0-9a-f]{8}$/

const EMPTY = { status: 204 } as const

/** Registers the routes; returns the undo. */
export function registerAgentRoutes(server: RouteServer, deps: AgentRoutesDeps): () => void {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))

  // A signal that names no job cannot say which session's turn it is, and with
  // several running there is no honest guess, so it is dropped (still answered
  // empty).
  const turn = (active: boolean) =>
    server.route(active ? '/turn/start' : '/turn/end', {
      body: 'discard',
      handle(remote, query) {
        const job = query.get('job') ?? ''
        const raw = query.get('pending')
        const pending = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
        if (JOB_ID.test(job)) deps.onJobTurn(remote, job, active, active ? null : pending)
        return EMPTY
      },
    })

  const undo = [
    turn(true),
    turn(false),
    server.route('/statusline', {
      body: 'text',
      handle(remote, query, body) {
        // Like a turn signal: a reading that names no job has no row to go on.
        const job = query.get('job') ?? ''
        if (JOB_ID.test(job)) {
          try {
            deps.onStatus?.(remote, job, JSON.parse(body))
          } catch (error) {
            log(`statusline failed: ${String(error)}`)
          }
        }
        return EMPTY
      },
    }),
  ]
  return () => undo.forEach((u) => u())
}
