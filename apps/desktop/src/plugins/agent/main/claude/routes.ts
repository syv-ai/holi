/**
 * Claude Code's routes on the bridge: how Holi learns when a
 * turn starts and ends, and how full a session's context is, WITHOUT parsing
 * PTY output (docs/features/agent-sessions.md).
 *
 * The seeded `UserPromptSubmit`/`Stop` hooks (`turn-signal.mjs`) POST
 * `/turn/start` and `/turn/end` with the vault's token and the session's job
 * id; the seeded status line POSTs Claude Code's status JSON to `/statusline`
 * the same way. **Every answer is empty but one**, since whatever a Claude Code
 * hook prints is injected into the agent's context: `/turn/end` answers, once
 * the settle commit for the turn has landed, `{ "tree": <its tree> }`, which
 * the Stop hook reads and saves and never prints.
 *
 * At a session's start (`SessionStart`, `/session`) and at each turn's start,
 * the hook's body carries the session's inbox socket and token, which Claude
 * Code exports to its hooks: how Holi adds a message to a running session
 * (`messaging.ts`). Kept in memory by the host, never written down.
 *
 * A turn's start also carries `pid`, the session's `claude` process
 * (`$CLAUDE_PID`, or the hook's parent on an older CLI), absent from a hook older than it: how the host tells a
 * session that died mid-turn from one the listing merely does not name
 * (`host/sessions.ts`).
 *
 * The job id rides beside the vault's standing token, because a background
 * session's environment comes from Claude Code's supervisor rather than from
 * Holi: no per-session bearer can reach it.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import type { RouteServer, TurnRouteDeps } from '../provider'
import { JOB_ID } from './listing'
import type { SessionChannel } from './messaging'

const EMPTY = { status: 204 } as const

/** A Windows named pipe, which is what Claude Code's inbox is there:
 *  `\\.\pipe\<name>`, the name free of control characters. */
const PIPE = /^\\\\\.\\pipe\\[^\x00-\x1f\\]+(?:\\[^\x00-\x1f\\]+)*$/

/** The inbox a hook's body names, or null when it names none or one that is
 *  not plausibly a socket path (a named pipe on Windows) and a token. */
function channelOf(body: string, platform: NodeJS.Platform): SessionChannel | null {
  if (body.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const { socket, token } = parsed as Record<string, unknown>
  if (typeof socket !== 'string' || typeof token !== 'string') return null
  const isPlace = socket.startsWith('/') || (platform === 'win32' && PIPE.test(socket))
  if (!isPlace || socket.length > 1024 || /[\0\n]/.test(socket)) return null
  if (!/^[\w.-]{1,512}$/.test(token)) return null
  return { socket, token }
}

/** Registers the routes; returns the undo. */
export function registerAgentRoutes(
  server: RouteServer,
  deps: TurnRouteDeps,
  platform: NodeJS.Platform = process.platform,
): () => void {
  const log = deps.log ?? ((msg: string) => console.log(`[agent] ${msg}`))

  // A signal that names no job cannot say which session's turn it is, and with
  // several running there is no honest guess, so it is dropped (still answered
  // empty).
  const channel = (remote: string, job: string, body: string): void => {
    const found = channelOf(body, platform)
    if (found !== null) deps.onChannel?.(remote, job, found)
  }

  const turn = (active: boolean) =>
    server.route(active ? '/turn/start' : '/turn/end', {
      body: active ? 'text' : 'discard',
      async handle(remote, query, body) {
        const job = query.get('job') ?? ''
        const raw = query.get('pending')
        const pending = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null
        const rawPid = query.get('pid')
        const pid = rawPid !== null && /^[1-9]\d{0,9}$/.test(rawPid) ? Number(rawPid) : undefined
        if (!JOB_ID.test(job)) return EMPTY
        // Before the turn: a message sent the moment it starts finds the inbox.
        if (active) channel(remote, job, body)
        const tree = await deps.onTurn(
          remote,
          job,
          active,
          active ? null : pending,
          active ? pid : undefined,
        )
        if (typeof tree !== 'string' || !/^[0-9a-f]{7,64}$/.test(tree)) return EMPTY
        return { status: 200, body: JSON.stringify({ tree }), contentType: 'application/json' }
      },
    })

  const undo = [
    turn(true),
    turn(false),
    server.route('/session', {
      body: 'text',
      handle(remote, query, body) {
        const job = query.get('job') ?? ''
        if (JOB_ID.test(job)) channel(remote, job, body)
        return EMPTY
      },
    }),
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
