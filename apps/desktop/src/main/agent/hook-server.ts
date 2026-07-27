/**
 * The turn-signal transport (prd/agent.md §Git coexistence): a tiny localhost
 * HTTP server the agent's Claude Code hooks POST to, so Holi learns when a turn
 * starts and ends WITHOUT parsing PTY output (see [[holi-no-custom-cc-state-monitoring]]).
 *
 * The seeded `UserPromptSubmit`/`Stop` hooks `curl` this on `127.0.0.1:$HOLI_HOOK_PORT`,
 * guarded so they no-op for a bare `claude` opened outside Holi. A per-instance
 * token (query `?t=`) rejects any other local process — the port is ephemeral,
 * but this closes the "some other localhost thing toggles our sync pause" gap.
 * Responses are always empty (a body would be injected into Claude's context).
 *
 * NOTE: no runtime `electron` import — this loads under vitest.
 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface HookServerDeps {
  onTurnStart(): void
  onTurnEnd(): void
  log?: (msg: string) => void
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
    // Drain (and discard) the body so the socket frees; cap it defensively.
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) req.destroy()
    })
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403).end()
        return
      }
      switch (url.pathname) {
        case '/turn/start':
          deps.onTurnStart()
          break
        case '/turn/end':
          deps.onTurnEnd()
          break
        default:
          res.writeHead(404).end()
          return
      }
      res.writeHead(204).end() // empty body — never inject text into Claude's context
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
