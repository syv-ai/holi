/**
 * Claude Code's routes on the bridge: how Holi learns when a
 * turn starts and ends, and how full a session's context is, WITHOUT parsing
 * PTY output (docs/features/agent-sessions.md).
 *
 * The seeded `UserPromptSubmit`/`Stop` hooks (`turn-signal.mjs`) POST
 * `/turn/start` and `/turn/end` with the vault's token and the session's job
 * id; the seeded status line POSTs Claude Code's status JSON to `/statusline`
 * the same way. **Their answers are empty**: whatever a turn hook prints is
 * injected into the agent's context. The exception is `/ask`, a quick agent's
 * question hook, whose printed JSON is its decision (`quick.ts`). Its other
 * hook posts each turn's last message to `/quick-result`, for its panel.
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
   *  by its short job id. */
  onJobTurn(remote: string, jobId: string, active: boolean): void
  /** A session's status line fired, with Claude Code's status JSON. Holi's
   *  side of a shipped hook must stay backward-compatible, so this route
   *  answers every older script too. */
  onStatus?(remote: string, jobId: string, status: unknown): void
  /**
   * A quick agent's question hook posted its tool call (`quick.ts`). Resolves
   * to what the hook prints once the person answers, or null to print nothing,
   * which leaves the question to Claude Code's own box. `signal` aborts when
   * the hook goes away first.
   */
  onAsk?(remote: string, jobId: string, hookInput: unknown, signal: AbortSignal): Promise<unknown>
  /** A quick agent's turn ended with this message, its answer, in markdown
   *  (`quick.ts`'s result hook). */
  onQuickResult?(remote: string, jobId: string, message: string): void
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
        if (JOB_ID.test(job)) deps.onJobTurn(remote, job, active)
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
    // A quick agent's answer: the `Stop` hook's `last_assistant_message`.
    server.route('/quick-result', {
      body: 'text',
      handle(remote, query, body) {
        const job = query.get('job') ?? ''
        if (!JOB_ID.test(job)) return EMPTY
        try {
          const input: unknown = JSON.parse(body)
          const message =
            typeof input === 'object' && input !== null
              ? (input as Record<string, unknown>)['last_assistant_message']
              : undefined
          if (typeof message === 'string') deps.onQuickResult?.(remote, job, message)
        } catch (error) {
          log(`quick result failed: ${String(error)}`)
        }
        return EMPTY
      },
    }),
    // The one route that answers with a body: a `PreToolUse` hook's JSON
    // stdout is its decision, not context. Anything Holi is not taking is
    // answered empty, and the hook prints nothing.
    server.route('/ask', {
      body: 'text',
      async handle(remote, query, body, signal) {
        const job = query.get('job') ?? ''
        if (!JOB_ID.test(job) || deps.onAsk === undefined) return EMPTY
        let input: unknown
        try {
          input = JSON.parse(body)
        } catch {
          return EMPTY
        }
        const output = await deps.onAsk(remote, job, input, signal).catch((error: unknown) => {
          log(`ask failed: ${String(error)}`)
          return null
        })
        if (output === null || output === undefined) return EMPTY
        return { status: 200, body: JSON.stringify(output), contentType: 'application/json' }
      },
    }),
  ]
  return () => undo.forEach((u) => u())
}
