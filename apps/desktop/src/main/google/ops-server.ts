/**
 * The agent's door to Google: a tiny localhost server that serves **results,
 * never tokens**.
 *
 * The agent runs as its own `claude` process, so it cannot reach main's IPC and
 * must not reach the keychain. Instead it asks this server, which calls Google
 * with main's own access token and hands back JSON. That keeps main the **sole
 * token authority**: there is exactly one refresher, so nothing races the
 * rotating refresh token, and a disconnect takes effect everywhere at once.
 *
 * The same shape as `bridge/server.ts`: ephemeral port, bearer token,
 * `127.0.0.1` only. It is why Google needs no MCP server: the agent reaches it
 * with `Bash` and a documented command (`holi-google`).
 *
 * No runtime `electron` import: this loads under vitest.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { EventPatch, NewEvent } from './calendar'
import type { OutgoingMail } from './mime'

export interface GoogleOps {
  // Reads. GET, because the whole request fits in a query string.
  agenda(window: { timeMin: string; timeMax: string }): Promise<unknown>
  threads(query: string | undefined): Promise<unknown>
  thread(id: string): Promise<unknown>

  /**
   * Writes. POST with a body: a mail body does not belong in a query
   * string, where it would also be printed into the confirmation prompt the
   * user reads.
   *
   * **`send` and `reply` are the two that reach another human.** Nothing here
   * enforces that; the gate is a `PreToolUse` hook on the agent's side, because
   * this server cannot tell an approved call from an unapproved one. This layer
   * guarantees only that the two are *nameable*: a separate route each.
   */
  setRead(id: string, read: boolean): Promise<void>
  star(id: string, on: boolean): Promise<void>
  archive(id: string): Promise<void>
  trash(id: string): Promise<void>
  draft(mail: OutgoingMail & { threadId?: string }): Promise<{ id: string | null }>
  /**
   * Send a composed message, or send a draft that already exists.
   *
   * **The draft form is not a convenience.** `draft` followed by a composed
   * `send` produces *two* messages and orphans the draft. `drafts.send` makes
   * Gmail delete the draft atomically, which is the only way "draft it, then
   * send it" ends with one message.
   */
  send(input: { mail: OutgoingMail } | { draftId: string }): Promise<{ id: string | null }>
  reply(threadId: string, body: string, all: boolean): Promise<{ id: string | null }>
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

/** Thrown for a body that is missing or not JSON: a mistake by the caller,
 *  which is a different answer from Google being unreachable. */
class BadRequest extends Error {}

/** Its own type, because it is its own status code (413). */
class TooLarge extends Error {}

/**
 * What a `Promise<void>` operation returns to the router.
 *
 * `undefined` already means "no such route" here, so an operation that
 * genuinely resolves to nothing needs a value that is not `undefined`, else
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
      // Stop *accumulating*, but keep draining. Destroying the socket kills the
      // connection before the 413 can be written, so the caller sees only a
      // connection reset. Discarding bounds memory just as well.
      oversize = true
      chunks.length = 0
      continue
    }
    if (!oversize) chunks.push(buffer)
  }
  if (oversize) throw new TooLarge('that request body is too large')
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}

  // Form-encoded is what the generated `holi-google` sends: `curl
  // --data-urlencode "body@-"` reads the message from stdin and encodes it, so
  // a mail body containing quotes, `$`, or a newline needs no escaping in POSIX
  // `sh`. Assembling JSON by hand in a shell script is a bug class of its own.
  const contentType = req.headers['content-type'] ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) return fromForm(text)

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

/**
 * A form body, given the shape the JSON routes already expect.
 *
 * Two rules, both chosen so a caller never has to say which it meant: a key
 * that appears more than once is an **array** (`to=a&to=b`), and the exact
 * strings `true`/`false` are **booleans**. Without the second one, `read=false`
 * would arrive as the truthy string `"false"`, so "mark it unread" would mark
 * it read and answer 200.
 */
function fromForm(text: string): Record<string, unknown> {
  const params = new URLSearchParams(text)
  const out: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    out[key] = values.length > 1 ? values : coerce(values[0]!)
  }
  return out
}

function coerce(value: string): string | boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

export interface GoogleOpsServer {
  start(): Promise<void>
  stop(): Promise<void>
  port(): number | null
  /**
   * A bearer bound to one vault, minted once per vault per app run,
   * written into that vault's `holi.env`, and revoked when Holi leaves it.
   *
   * Bound to a vault rather than resolved by "whatever is active": a
   * background session **outlives a vault switch**, and must not then read a
   * different vault's mail. Revoked on leave, so a token does not stay valid
   * for a vault Holi is no longer on.
   */
  mintToken(remote: string): string
  revoke(token: string): void
}

/**
 * @param opsFor the operations for one vault. Called per request, from the
 *  vault named by the request's bearer, never from the active vault.
 */
export function createGoogleOpsServer(opsFor: (remote: string) => GoogleOps): GoogleOpsServer {
  /** token → the vault it speaks for. */
  const tokens = new Map<string, string>()
  let server: Server | null = null
  let boundPort: number | null = null

  const handle: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      // The port is ephemeral, but that is not a boundary: the token is what
      // stops some other local process reading your mail.
      const remote = tokens.get(url.searchParams.get('t') ?? '')
      if (remote === undefined) {
        res.writeHead(403).end()
        return
      }

      try {
        // The body is read only after the token has been checked, so an
        // unauthenticated caller never gets to hand this process JSON to parse.
        const ops = opsFor(remote)
        const result =
          req.method === 'POST'
            ? await routeWrite(ops, url, await readBody(req))
            : await route(ops, url)
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
        // them makes it retry the one that will never work.
        const status = err instanceof BadRequest ? 400 : err instanceof TooLarge ? 413 : 502
        // The agent reads this text, so it has to say what to do.
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'the Google request failed',
          }),
        )
      }
    })()
  }

  async function route(ops: GoogleOps, url: URL): Promise<unknown> {
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
  async function routeWrite(
    ops: GoogleOps,
    url: URL,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const id = () => {
      const value = body.id
      if (typeof value !== 'string' || value === '')
        throw new BadRequest('this operation needs an id')
      return value
    }
    /** One recipient or several. A form body cannot tell them apart: `to=a`
     *  is a scalar and `to=a&to=b` is an array — so both are accepted rather
     *  than making the caller know which shape it produced. */
    const addresses = (value: unknown): string[] => {
      if (typeof value === 'string') return value === '' ? [] : [value]
      if (Array.isArray(value)) return value.map(String).filter((v) => v !== '')
      return []
    }

    const mail = () => {
      const { subject, body: text } = body
      const to = addresses(body.to)
      if (to.length === 0) throw new BadRequest('to is required')
      if (typeof subject !== 'string') throw new BadRequest('subject is required')
      if (typeof text !== 'string') throw new BadRequest('body is required')
      const cc = addresses(body.cc)
      return { to, subject, body: text, ...(cc.length > 0 ? { cc } : {}) }
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
      case '/send': {
        // `--draft` and a composed message are alternatives, not a merge: a
        // draft already carries its recipients, subject and threading headers,
        // and taking half from each is how a send goes somewhere unintended.
        const draftId = body.draftId
        if (typeof draftId === 'string' && draftId !== '') return ops.send({ draftId })
        return ops.send({ mail: mail() })
      }
      case '/reply': {
        const { threadId, body: text } = body
        if (typeof threadId !== 'string' || threadId === '') {
          throw new BadRequest('reply needs a threadId')
        }
        if (typeof text !== 'string') throw new BadRequest('reply needs a body')
        // Defaults to a reply to the sender. Widening to everyone on the thread
        // has to be asked for — see `replyToThread`.
        return ops.reply(threadId, text, body.all === true)
      }
      case '/schedule': {
        const { title, start, end, allDay, location, description } = body
        if (typeof title !== 'string' || title === '')
          throw new BadRequest('schedule needs a title')
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
    mintToken(remote) {
      const token = randomBytes(16).toString('hex')
      tokens.set(token, remote)
      return token
    },
    revoke(token) {
      tokens.delete(token) // idempotent: a restart revokes before it mints
    },
  }
}
