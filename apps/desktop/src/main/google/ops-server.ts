/**
 * The agent's door to Google — a tiny localhost server that serves **results,
 * never tokens** (D67).
 *
 * The agent runs as its own `claude` process, so it cannot reach main's IPC and
 * must not reach the keychain. Instead it asks this server, which calls Google
 * with main's own access token and hands back JSON. That keeps main the **sole
 * token authority**: there is exactly one refresher, so nothing races the
 * rotating refresh token, and a disconnect takes effect everywhere at once.
 *
 * It is deliberately the same shape as `agent/hook-server.ts` — ephemeral port,
 * per-instance token, `127.0.0.1` only — because that pattern is already proven
 * here and a second bespoke transport would be a second thing to get wrong.
 *
 * **This is why the pillar needs no MCP server** (and why the "pure Claude Code"
 * stance survives phase 2): the agent reaches external data with `Bash` and a
 * documented command, exactly as it reaches everything else with native tools.
 *
 * NOTE: no runtime `electron` import — this loads under vitest.
 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface GoogleOps {
  agenda(window: { timeMin: string; timeMax: string }): Promise<unknown>
  threads(query: string | undefined): Promise<unknown>
  thread(id: string): Promise<unknown>
}

export interface GoogleOpsServer {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number | null
  token(): string
}

export function createGoogleOpsServer(ops: GoogleOps): GoogleOpsServer {
  const token = randomBytes(16).toString('hex')
  let server: Server | null = null
  let boundPort: number | null = null

  const handle: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      // The port is ephemeral, but that is not a boundary — this closes the
      // "some other local process reads your mail" gap.
      if (url.searchParams.get('t') !== token) {
        res.writeHead(403).end()
        return
      }

      try {
        const result = await route(url)
        if (result === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown operation' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        // The agent reads this text, so it has to say what to do rather than
        // just that something failed.
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ error: err instanceof Error ? err.message : 'the Google request failed' }),
        )
      }
    })()
  }

  async function route(url: URL): Promise<unknown> {
    const q = url.searchParams
    switch (url.pathname) {
      case '/agenda': {
        // Defaults keep the common call short: `agenda` with no arguments means
        // the next 7 days. The agent may still pass an explicit window.
        const timeMin = q.get('timeMin') ?? new Date().toISOString()
        const timeMax =
          q.get('timeMax') ?? new Date(Date.parse(timeMin) + 7 * 86_400_000).toISOString()
        return ops.agenda({ timeMin, timeMax })
      }
      case '/threads':
        return ops.threads(q.get('q') ?? undefined)
      case '/thread': {
        const id = q.get('id')
        if (id === null) throw new Error('thread requires an id')
        return ops.thread(id)
      }
      default:
        return undefined
    }
  }

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        const s = createServer(handle)
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
          const address = s.address()
          boundPort = address !== null && typeof address !== 'string' ? address.port : null
          server = s
          resolve()
        })
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        if (server === null) {
          resolve()
          return
        }
        server.closeAllConnections()
        server.close(() => resolve())
        server = null
        boundPort = null
      }),
    port: () => boundPort,
    token: () => token,
  }
}
