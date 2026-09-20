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
  /** A turn began in this session. Only ever a session's own token, never the
   *  vault's standing one — see `TokenBearer`. */
  onTurnStart(sessionId: string): void
  onTurnEnd(sessionId: string): void
  /**
   * This session's status line asked what to print (D101).
   *
   * The whole of Claude Code's status JSON arrives as the body, and what comes
   * back is the one line the session's footer shows. Holi does the parsing
   * because the alternative is a shell script picking fields out of JSON with
   * `sed`, and because main wants two of those fields for itself: the model and
   * the context reading go on the wire with the session list, and `session_name`
   * carries the title Claude Code's own small-model pass wrote.
   */
  onStatus?: (sessionId: string, status: unknown) => string
  log?: (msg: string) => void
  /**
   * The agent-ops routes for **one vault**, if this instance has them. Absent —
   * in tests, and before main wires them — leaves every ops path a 404 rather
   * than a crash.
   *
   * Resolved from the caller's token rather than from the active vault (D87's
   * lesson, applied here): a `git commit` in one vault used to run its staged
   * pre-commit transforms against whichever vault was on screen, which is a
   * write to the wrong repository rather than merely a wrong read.
   */
  opsFor?: (remote: string) => AgentOps
}

export interface HookServer {
  /** Bind 127.0.0.1 on an ephemeral port. */
  start(): Promise<void>
  stop(): Promise<void>
  /** The bound port, or null before `start()`. */
  port(): number | null
  /**
   * This vault's standing token, minted once and stable for the app's life.
   *
   * It is written into the clone's `.git/hooks`, so it has to keep working
   * across agent sessions and vault switches. Never revoked.
   */
  tokenForVault(remote: string): string
  /** A token for one agent session in one vault, revoked when it ends. The id
   *  is what a turn signal on this token reports, so several sessions in one
   *  vault stay apart. */
  mintSessionToken(remote: string, sessionId: string): string
  revoke(token: string): void
}

/** Cap the drained request body — the hooks send nothing we read, so this is
 *  purely a guard against a runaway sender holding the socket open. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * What a token speaks for. Always a vault, because that is how an ops route
 * finds the repository to act on. A session id as well **only** when the token
 * was minted for one session: the vault's standing token is written into
 * `.git/hooks` and outlives every session, so it cannot name one.
 */
interface TokenBearer {
  remote: string
  sessionId?: string
}

export function createHookServer(deps: HookServerDeps): HookServer {
  const log = deps.log ?? ((msg: string) => console.log(`[hook-server] ${msg}`))
  /** token → what it speaks for. */
  const tokens = new Map<string, TokenBearer>()
  /** remote → its standing token, so a vault's `.git/hooks` file stays valid. */
  const vaultTokens = new Map<string, string>()
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
    const bearer = tokens.get(url.searchParams.get('t') ?? '')
    if (bearer === undefined) {
      req.resume()
      res.writeHead(403).end()
      return
    }

    const isTurn = url.pathname === '/turn/start' || url.pathname === '/turn/end'
    const isStatus = url.pathname === '/statusline'

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
      if (isStatus) {
        // A status line belongs to exactly one session, and the bearer says
        // which — so nothing here has to guess, and the vault's standing token
        // (which names no session) simply prints nothing.
        let line = ''
        if (bearer.sessionId !== undefined && deps.onStatus !== undefined) {
          try {
            line = deps.onStatus(bearer.sessionId, JSON.parse(body))
          } catch (error) {
            // Malformed JSON, or a bug in the reader. An empty status line is a
            // blank row in a terminal; a 500 here would be a red one.
            log(`statusline failed: ${String(error)}`)
          }
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(line)
        return
      }
      if (isTurn) {
        // A turn signal on the vault's standing token names no session, and with
        // several running there is no honest guess: applying it to an arbitrary
        // one would pause and resume the vault under a session that never ran.
        // Dropped, but still answered empty — a body enters Claude's context.
        if (bearer.sessionId !== undefined) {
          if (url.pathname === '/turn/start') deps.onTurnStart(bearer.sessionId)
          else deps.onTurnEnd(bearer.sessionId)
        }
        res.writeHead(204).end() // empty body — never inject text into Claude's context
        return
      }

      // Body params win over query params: both are accepted so the CLI can use
      // whichever curl form fits, and the body is the one curl encoded.
      const params = new URLSearchParams(url.search)
      for (const [key, value] of new URLSearchParams(body)) params.set(key, value)

      void Promise.resolve(deps.opsFor?.(bearer.remote)(url.pathname, params) ?? null)
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
    tokenForVault(remote) {
      let token = vaultTokens.get(remote)
      if (token === undefined) {
        token = randomBytes(16).toString('hex')
        vaultTokens.set(remote, token)
        tokens.set(token, { remote })
      }
      return token
    },
    mintSessionToken(remote, sessionId) {
      const token = randomBytes(16).toString('hex')
      tokens.set(token, { remote, sessionId })
      return token
    },
    revoke(token) {
      // A vault's standing token is not revocable through here: it lives in a
      // file on disk and must outlast the session that happened to be open.
      if (vaultTokens.get(tokens.get(token)?.remote ?? '') === token) return
      tokens.delete(token)
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
