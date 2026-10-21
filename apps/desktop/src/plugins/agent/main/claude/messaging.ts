/**
 * Adding a message to a running Claude Code session: its inbox socket
 * (Claude Code's cross-session messaging, docs/features/agent-sessions.md).
 *
 * Every session that is not `--bare` binds a Unix socket and exports its path
 * and a per-session token to its hooks as `CLAUDE_CODE_MESSAGING_SOCKET` and
 * `CLAUDE_CODE_MESSAGING_TOKEN`. The seeded `turn-signal.mjs` hands both to
 * Holi, which keeps them in memory only (`host/sessions.ts`).
 *
 * One connection per message: the auth line, the one user line, then close.
 * An idle session starts a turn with it; a working one reads it after the
 * tool call in flight. The token makes it count as the session's own child,
 * so a session that skips permission prompts does not hold it for approval.
 *
 * **The user line's shape is not on Claude Code's documentation page**, which
 * describes only the auth line. It is the shape Claude Code's own debug log
 * names, checked live; a release that changes it breaks this module and
 * nothing else.
 *
 * The socket answers nothing. A session whose `crossSessionInbound` is
 * `refuse` drops the message without a word, and `hold` sets it aside, so all
 * this can report is whether the bytes were taken. It never retries: a
 * message sent twice is a turn taken twice.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { createConnection } from 'node:net'
import { CapabilityError } from '../../../../main/plugin-api'

/** Where one session takes messages, as its hooks were told. */
export interface SessionChannel {
  socket: string
  token: string
}

/** Claude Code closes a connection that sends no complete line in 30 s; a
 *  message is two short lines, so a few seconds is already a dead session. */
const TIMEOUT_MS = 5_000

/** The bytes one message is: the auth line, then the user line. */
export function messageLines(channel: SessionChannel, text: string): string {
  return (
    JSON.stringify({ type: 'auth', token: channel.token }) +
    '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) +
    '\n'
  )
}

/** Why a write failed, in the person's words. */
function refusal(error: NodeJS.ErrnoException): CapabilityError {
  const gone = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
  return new CapabilityError(
    'UNAVAILABLE',
    gone
      ? 'the session is no longer taking messages (its inbox socket is gone)'
      : `the session's inbox did not take the message: ${error.message}`,
  )
}

/** Write one message into the session's inbox. Resolves once the session has
 *  the bytes; throws a `CapabilityError` when it could not be delivered. */
export function postToSession(
  channel: SessionChannel,
  text: string,
  timeoutMs = TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (error?: CapabilityError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const conn = createConnection(channel.socket)
    const timer = setTimeout(() => {
      conn.destroy()
      done(new CapabilityError('UNAVAILABLE', "the session's inbox did not answer in time"))
    }, timeoutMs)
    conn.on('error', (error: NodeJS.ErrnoException) => done(refusal(error)))
    conn.on('connect', () => {
      conn.end(messageLines(channel, text), () => {
        conn.destroy()
        done()
      })
    })
  })
}
