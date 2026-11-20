/**
 * Adding a message to a running Claude Code session through its inbox socket.
 * See docs/features/agent-sessions.md for the wire protocol.
 *
 * This module has no Electron dependency and keeps socket lifecycle rules
 * behind postToSession's small interface.
 */
import { createConnection, type Socket } from 'node:net'
import { CapabilityError } from '../../../../main/plugin-api'

/** Where one session takes messages, as its hooks were told. */
export interface SessionChannel {
  socket: string
  token: string
}

const TIMEOUT_MS = 5_000

type SocketFactory = (path: string) => Socket

function messageLines(channel: SessionChannel, text: string): string {
  return (
    JSON.stringify({ type: 'auth', token: channel.token }) +
    '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) +
    '\n'
  )
}

function refusal(error: NodeJS.ErrnoException): CapabilityError {
  const gone = error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
  return new CapabilityError(
    'UNAVAILABLE',
    gone
      ? 'the session is no longer taking messages (its inbox socket is gone)'
      : 'the session inbox connection failed before delivery could be confirmed',
  )
}

/**
 * Send exactly once. Settlement joins the socket's physical close: write/end
 * callbacks alone cannot establish that the connection has been torn down.
 * A cancellation or timeout after end() is deliberately not described as safe
 * to retry, since the session may already have received the message.
 */
export function postToSession(
  channel: SessionChannel,
  text: string,
  timeoutMs = TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  return postToSessionWithSocketFactory(channel, text, timeoutMs, signal, createConnection)
}

/** @public Test seam: inject deterministic sockets to verify inbox lifecycle behavior. */
export function postToSessionWithSocketFactory(
  channel: SessionChannel,
  text: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  makeSocket: SocketFactory,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new CapabilityError('UNAVAILABLE', 'session message was cancelled'))
  }

  return new Promise((resolve, reject) => {
    let conn: Socket
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let closing = false
    let sent = false
    let outcome: CapabilityError | null = null

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settleOnClose = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (outcome) reject(outcome)
      else if (sent) resolve()
      else
        reject(
          new CapabilityError(
            'UNAVAILABLE',
            'the session inbox closed before accepting the message',
          ),
        )
    }
    const failAndClose = (error: CapabilityError): void => {
      if (!outcome) outcome = error
      if (closing) return
      closing = true
      conn.destroy()
    }
    const onAbort = (): void => {
      failAndClose(
        new CapabilityError(
          'UNAVAILABLE',
          'session message was cancelled; delivery may be uncertain',
        ),
      )
    }

    // Set timer state before socket construction/listener callbacks can fire.
    timer = setTimeout(() => {
      failAndClose(
        new CapabilityError(
          'UNAVAILABLE',
          'the session inbox did not answer in time; delivery may be uncertain',
        ),
      )
    }, timeoutMs)
    try {
      conn = makeSocket(channel.socket)
    } catch {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new CapabilityError('UNAVAILABLE', 'could not connect to the session inbox'))
      return
    }

    conn.on('close', settleOnClose)
    conn.on('error', (error: NodeJS.ErrnoException) => failAndClose(refusal(error)))
    conn.on('connect', () => {
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (outcome || closing) return
      // Set sent before end(): synchronous adapters may emit callbacks inline.
      sent = true
      try {
        conn.end(messageLines(channel, text))
      } catch {
        sent = false
        failAndClose(
          new CapabilityError('UNAVAILABLE', 'the session inbox could not accept the message'),
        )
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    // Cover abort between the initial check and listener registration.
    if (signal?.aborted) onAbort()
  })
}
