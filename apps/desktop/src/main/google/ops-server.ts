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
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http'
import { randomBytes } from 'node:crypto'
import type { EventPatch, NewEvent } from './calendar'
import type { OutgoingMail } from './mime'

export interface GoogleOps {
  // Reads. GET, because the whole request fits in a query string.
  agenda(window: { timeMin: string; timeMax: string }): Promise<unknown>
  threads(query: string | undefined): Promise<unknown>
  thread(id: string): Promise<unknown>

  /**
   * Writes (D70). POST with a JSON body — a mail body does not belong in a
   * query string, and putting one there would also print the whole message
   * into the text of the confirmation prompt the user reads.
   *
   * **`send` and `reply` are the two that reach another human.** Nothing here
   * enforces that; the gate is a `PreToolUse` hook on the agent's side, because
   * this server cannot tell an approved call from an unapproved one. What this
   * layer does guarantee is that the two are *nameable* — a separate route each,
   * rather than hiding inside a general-purpose verb the gate cannot match.
   */
  setRead(id: string, read: boolean): Promise<void>
  star(id: string, on: boolean): Promise<void>
  archive(id: string): Promise<void>
  trash(id: string): Promise<void>
  draft(mail: OutgoingMail & { threadId?: string }): Promise<{ id: string | null }>
  send(mail: OutgoingMail): Promise<{ id: string | null }>
  reply(threadId: string, body: string): Promise<{ id: string | null }>
  schedule(event: NewEvent): Promise<{ id: string | null }>
  reschedule(id: string, patch: EventPatch): Promise<void>
  unschedule(id: string): Promise<void>
}

/**
 * A body big enough to be a mistake. Localhost or not, an unbounded
 * `req.on('data')` accumulator is a way to exhaust this process's memory, and
 * no legitimate request here is close to a megabyte.
 */
const MAX_BODY_BYTES = 1024 * 1024

/** Thrown for a body that is missing or not JSON — a mistake by the caller,
 *  which is a different answer from Google being unreachable. */
class BadRequest extends Error {}

/** Its own type, because it is its own status code (413) and because "you sent
 *  too much" is worth saying rather than folding into "that was malformed". */
class TooLarge extends Error {}

/**
 * What a `Promise<void>` operation returns to the router.
 *
 * `undefined` already means "no such route" here, so an operation that
 * genuinely resolves to nothing needs a value that is not `undefined` — else
 * every successful archive would answer 404.
 */
const NO_CONTENT = Symbol('no-content')

/** Await a void operation and report it as a result rather than as a 404. */
async function NO_CONTENT_AFTER(work: Promise<void>): Promise<typeof NO_CONTENT> {
  await work
  return NO_CONTENT
}

/**
 * Read and parse a JSON request body, bounded.
 *
 * The bound is enforced as the chunks arrive rather than after: a limit checked
 * once the body is already in memory is not a limit.
 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  let oversize = false
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      // Stop *accumulating*, but keep draining. Destroying the socket here is
      // the obvious move and it is wrong: it kills the connection before the
      // 413 can be written, so the caller sees a connection reset and has no
      // idea what it did. Memory is what needs bounding, and discarding bounds
      // it just as well as hanging up does.
      oversize = true
      chunks.length = 0
      continue
    }
    if (!oversize) chunks.push(buffer)
  }
  if (oversize) throw new TooLarge('that request body is too large')
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BadRequest('the request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest('the request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
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
        // The body is read only after the token has been checked, so an
        // unauthenticated caller never gets to hand this process JSON to parse.
        const result =
          req.method === 'POST' ? await routeWrite(url, await readBody(req)) : await route(url)
        if (result === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown operation' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result === NO_CONTENT ? { ok: true } : result))
      } catch (err) {
        // 400 and 502 are read apart by the agent: one means "fix the request",
        // the other means "Google is unreachable, try again later". Collapsing
        // them into one code makes it retry the one that will never work.
        const status = err instanceof BadRequest ? 400 : err instanceof TooLarge ? 413 : 502
        // The agent reads this text, so it has to say what to do rather than
        // just that something failed.
        res.writeHead(status, { 'Content-Type': 'application/json' })
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

  /**
   * The write routes. Each one names its operation, which is the property the
   * gate depends on: `send` is a route, not a flag on a general-purpose verb,
   * so a hook matching on the command that reaches it has something to match.
   */
  async function routeWrite(url: URL, body: Record<string, unknown>): Promise<unknown> {
    const id = () => {
      const value = body.id
      if (typeof value !== 'string' || value === '') throw new BadRequest('this operation needs an id')
      return value
    }
    const mail = () => {
      const { to, subject, body: text, cc } = body
      if (!Array.isArray(to) || to.length === 0) throw new BadRequest('to is required')
      if (typeof subject !== 'string') throw new BadRequest('subject is required')
      if (typeof text !== 'string') throw new BadRequest('body is required')
      return {
        to: to.map(String),
        subject,
        body: text,
        ...(Array.isArray(cc) ? { cc: cc.map(String) } : {}),
      }
    }

    switch (url.pathname) {
      case '/mark-read':
        // `read` defaults to true: "mark-read" with no argument means what it
        // says, and the flag is how the agent asks for the other direction.
        return NO_CONTENT_AFTER(ops.setRead(id(), body.read !== false))
      case '/star':
        return NO_CONTENT_AFTER(ops.star(id(), body.on !== false))
      case '/archive':
        return NO_CONTENT_AFTER(ops.archive(id()))
      case '/trash':
        return NO_CONTENT_AFTER(ops.trash(id()))
      case '/draft':
        return ops.draft({
          ...mail(),
          ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
        })
      case '/send':
        return ops.send(mail())
      case '/reply': {
        const { threadId, body: text } = body
        if (typeof threadId !== 'string' || threadId === '') {
          throw new BadRequest('reply needs a threadId')
        }
        if (typeof text !== 'string') throw new BadRequest('reply needs a body')
        return ops.reply(threadId, text)
      }
      case '/schedule': {
        const { title, start, end, allDay, location, description } = body
        if (typeof title !== 'string' || title === '') throw new BadRequest('schedule needs a title')
        if (typeof start !== 'string' || typeof end !== 'string') {
          throw new BadRequest('schedule needs a start and an end')
        }
        return ops.schedule({
          title,
          start,
          end,
          ...(allDay === true ? { allDay: true } : {}),
          ...(typeof location === 'string' ? { location } : {}),
          ...(typeof description === 'string' ? { description } : {}),
        })
      }
      case '/reschedule': {
        const { start, end, title, allDay } = body
        return NO_CONTENT_AFTER(
          ops.reschedule(id(), {
            ...(typeof start === 'string' ? { start } : {}),
            ...(typeof end === 'string' ? { end } : {}),
            ...(typeof title === 'string' ? { title } : {}),
            ...(allDay === true ? { allDay: true } : {}),
          }),
        )
      }
      case '/unschedule':
        return NO_CONTENT_AFTER(ops.unschedule(id()))
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
