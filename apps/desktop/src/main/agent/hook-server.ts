/**
 * The turn-signal transport (prd/agent.md §Git coexistence): a tiny localhost
 * HTTP server the agent's Claude Code hooks POST to, so Holi learns when a turn
 * starts and ends WITHOUT parsing PTY output (see [[holi-no-custom-cc-state-monitoring]]).
 *
 * The seeded `UserPromptSubmit`/`Stop` hooks `curl` this on `127.0.0.1:$HOLI_HOOK_PORT`,
 * guarded so they no-op for a bare `claude` opened outside Holi. A per-instance
 * token (query `?t=`) rejects any other local process — the port is ephemeral,
 * but this closes the "some other localhost thing toggles our sync pause" gap.
 * A turn-signal response is always empty (a body would be injected into
 * Claude's context). The same server also carries the **agent ops** routes the
 * `holi` CLI calls (`ops.ts`), and those DO answer: they are replies to a
 * command the agent typed, not to a hook it never sees. The two classes are
 * routed apart here so that distinction cannot blur.
 *
 * NOTE: no runtime `electron` import — this loads under vitest.
 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AgentOps } from './ops'

export interface HookServerDeps {
  onTurnStart(): void
  onTurnEnd(): void
  log?: (msg: string) => void
  /** The agent-ops routes, if this instance has them. Absent — in tests, and
   *  before main wires them — leaves every ops path a 404 rather than a crash. */
  ops?: AgentOps
}

export interface HookServer {
  /** Bind 127.0.0.1 on an ephemeral port. */
  start(): Promise<void>
  stop(): Promise<void>
  /** The bound port, or null before `start()`. */
  port(): number | null
  /** The per-instance auth token the hooks must present. */
  token(): string
}

/** Cap the drained request body — the hooks send nothing we read, so this is
 *  purely a guard against a runaway sender holding the socket open. */
const MAX_BODY_BYTES = 64 * 1024

export function createHookServer(deps: HookServerDeps): HookServer {
  const log = deps.log ?? ((msg: string) => console.log(`[hook-server] ${msg}`))
  const token = randomBytes(16).toString('hex')
  let server: Server | null = null
  let boundPort: number | null = null

  const handle: RequestListener = (req, res) => {
    if (req.method !== 'POST') {
      req.resume()
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // **The token is checked on the headers, before a byte of body is read.**
    // Draining first would mean an unauthenticated local process could make us
    // buffer up to the cap on every request just by being wrong about the token.
    if (url.searchParams.get('t') !== token) {
      req.resume()
      res.writeHead(403).end()
      return
    }

    const isTurn = url.pathname === '/turn/start' || url.pathname === '/turn/end'

    // A turn signal sends nothing we read, so its body is drained and discarded;
    // an ops route's arguments ride in the body so `curl --data-urlencode`
    // encodes them for us, the way the Google CLI already does.
    let body = ''
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      if (!isTurn) body += chunk.toString('utf8')
    })

    req.on('end', () => {
      if (isTurn) {
        if (url.pathname === '/turn/start') deps.onTurnStart()
        else deps.onTurnEnd()
        res.writeHead(204).end() // empty body — never inject text into Claude's context
        return
      }

      // Body params win over query params: both are accepted so the CLI can use
      // whichever curl form fits, and the body is the one curl encoded.
      const params = new URLSearchParams(url.search)
      for (const [key, value] of new URLSearchParams(body)) params.set(key, value)

      void Promise.resolve(deps.ops?.(url.pathname, params) ?? null)
        .then((reply) => {
          if (reply === null) {
            res.writeHead(404).end()
            return
          }
          res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
        })
        .catch((error: unknown) => {
          // Only reached if an ops route itself throws outside its own try —
          // a bug in Holi, not an answer to the agent.
          log(`ops ${url.pathname} failed: ${String(error)}`)
          res.writeHead(500).end()
        })
    })
  }

  return {
    token: () => token,
    port: () => boundPort,
    start: () =>
      new Promise<void>((resolve, reject) => {
        const s = createServer(handle)
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
          const addr = s.address()
          boundPort = typeof addr === 'object' && addr ? addr.port : null
          server = s
          log(`listening on 127.0.0.1:${boundPort}`)
          resolve()
        })
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        const s = server
        server = null
        boundPort = null
        if (!s) return resolve()
        s.close(() => resolve())
      }),
  }
}
