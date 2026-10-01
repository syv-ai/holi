/**
 * The bridge: a tiny localhost HTTP server that whatever runs inside a vault
 * (the `holi` command, the agent's Claude Code hooks, git's pre-commit hook and
 * merge driver) POSTs to, to reach the running Holi.
 *
 * Every request carries the vault's standing token (query `?t=`), which names
 * the vault it speaks for and rejects any other local process: the port is
 * ephemeral, but this closes the "some other localhost thing toggles our sync
 * pause" gap. The token is checked on the headers, before any body is read.
 *
 * **Two kinds of path.** A capability call is built in (`/cap/<name>`, through
 * `dispatch`), so every verb the agent can type is a capability and not a
 * route. A route is for a caller that is not an agent verb: the agent's turn
 * and status-line hooks, which must answer empty because a body would be
 * injected into Claude's context (`agent/bridge-routes.ts`), and git's
 * pre-commit hook and merge driver (`vault/git-routes.ts`). Each owner
 * registers its own routes from the composition root.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Dispatch } from '../capabilities/dispatch'

/** What a route answers. No body is an empty one. */
export interface Reply {
  status: number
  body?: string
  /** `text/plain` when absent. */
  contentType?: string
}

export interface Route {
  /** `discard` drains the body unread (a turn signal sends nothing worth
   *  reading); `text` hands it over as UTF-8. */
  body: 'discard' | 'text'
  /** For the vault the token names. `query` is the URL's, token included. */
  handle(remote: string, query: URLSearchParams, body: string): Reply | Promise<Reply>
}

export interface BridgeServerDeps {
  /** The capability door. Absent leaves `/cap/` a 404. */
  dispatch?: Dispatch
  log?: (msg: string) => void
}

export interface BridgeServer {
  /** Bind 127.0.0.1 on an ephemeral port. */
  start(): Promise<void>
  stop(): Promise<void>
  /** The bound port, or null before `start()`. */
  port(): number | null
  /**
   * This vault's standing token, minted once and stable for the app's life.
   *
   * Git's hooks in the clone read it while Holi runs, and so do the agent's
   * sessions, so it has to keep working across agent sessions and vault
   * switches. Never revoked.
   */
  tokenForVault(remote: string): string
  /** Serve one exact path. Throws if it is taken. Returns the undo. */
  route(path: string, route: Route): () => void
}

/** Cap the request body: a guard against a runaway sender holding the socket
 *  open. A turn signal sends nothing and a status JSON is a few kilobytes, but
 *  the record merge driver sends three versions of a record of up to
 *  `MAX_RECORD_BYTES`, URL-encoded (which can triple JSON), so the cap sits
 *  above that rather than failing a merge git could have made cleanly. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const CAP_PREFIX = '/cap/'

const TEXT = 'text/plain; charset=utf-8'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createBridgeServer(deps: BridgeServerDeps = {}): BridgeServer {
  const log = deps.log ?? ((msg: string) => console.log(`[bridge] ${msg}`))
  /** token → the vault it speaks for. */
  const tokens = new Map<string, string>()
  /** remote → its standing token. */
  const vaultTokens = new Map<string, string>()
  const routes = new Map<string, Route>()
  let server: Server | null = null
  let boundPort: number | null = null

  /**
   * One capability through the CLI door. Its output is the answer itself, so
   * it answers text: 200 with it, or 422 with the refusal's one line. Fields
   * ride in the body so curl encodes them; `json=true` asks for the value.
   */
  async function capability(
    name: string,
    remote: string,
    query: URLSearchParams,
    body: string,
  ): Promise<Reply> {
    const fields: Record<string, string> = {}
    for (const [key, value] of query) fields[key] = value
    for (const [key, value] of new URLSearchParams(body)) fields[key] = value
    const { t: _t, json, ...params } = fields
    try {
      const result = await deps.dispatch!({ door: 'cli', remote, bundle: null, name, params })
      return {
        status: 200,
        body: json === 'true' ? JSON.stringify(result.value, null, 2) : result.text,
      }
    } catch (error) {
      return { status: 422, body: message(error) }
    }
  }

  /** The route for a path: a registered one, or the built-in capability door. */
  const routeFor = (pathname: string): Route | undefined => {
    const exact = routes.get(pathname)
    if (exact !== undefined) return exact
    if (deps.dispatch === undefined || !pathname.startsWith(CAP_PREFIX)) return undefined
    const name = pathname.slice(CAP_PREFIX.length)
    return { body: 'text', handle: (remote, query, body) => capability(name, remote, query, body) }
  }

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
    const remote = tokens.get(url.searchParams.get('t') ?? '')
    if (remote === undefined) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const route = routeFor(url.pathname)
    if (route === undefined) {
      req.resume()
      res.writeHead(404).end()
      return
    }

    let body = ''
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      if (route.body === 'text') body += chunk.toString('utf8')
    })

    req.on('end', () => {
      void Promise.resolve()
        .then(() => route.handle(remote, new URLSearchParams(url.search), body))
        .then((reply) => {
          if (reply.body === undefined || reply.body === '') {
            res.writeHead(reply.status).end()
            return
          }
          res.writeHead(reply.status, { 'content-type': reply.contentType ?? TEXT }).end(reply.body)
        })
        .catch((error: unknown) => {
          // Only reached if a route throws outside its own handling: a bug in
          // Holi, not an answer to the caller.
          log(`${url.pathname} failed: ${String(error)}`)
          res.writeHead(500).end()
        })
    })
  }

  return {
    tokenForVault(remote) {
      let token = vaultTokens.get(remote)
      if (token === undefined) {
        token = randomBytes(16).toString('hex')
        vaultTokens.set(remote, token)
        tokens.set(token, remote)
      }
      return token
    },
    route(path, route) {
      if (routes.has(path) || path.startsWith(CAP_PREFIX)) {
        throw new Error(`bridge route ${path} is already taken`)
      }
      routes.set(path, route)
      return () => {
        if (routes.get(path) === route) routes.delete(path)
      }
    },
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
