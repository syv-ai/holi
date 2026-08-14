/**
 * Why a send or save did not happen, and what the user can do about it (D71).
 *
 * Separated from the composer because the *action* is the point. A message
 * alone leaves the user reading an apology; `scope` and `reconnect` have a fix
 * the user can perform, `rate-limit` has one worth offering, and everything
 * else has none — in which case the right outcome is to hand the text back
 * unchanged and say so.
 *
 * **The code first, the prose second**, for the same reason `MailView` does it:
 * `rethrowGoogle` maps `GoogleApiError.code` onto a tRPC code precisely so the
 * UI does not have to read Google's sentences. The regexes below are the
 * fallback for an error that arrived without a code.
 */

export type SendFailureAction = 'reconnect' | 'retry' | null

export interface SendFailure {
  message: string
  /** `reconnect` routes to vault settings; `retry` re-offers the same call;
   *  `null` means the only sane move is back to the composer, text intact. */
  action: SendFailureAction
}

/** tRPC's verdict, as `ipcLink` rebuilt it onto `err.data.code`. */
function codeOf(error: unknown): string | null {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : null
}

const RECONNECT: SendFailure = {
  message: 'Holi needs permission to send mail. Reconnect Google in vault settings.',
  action: 'reconnect',
}

const RATE_LIMITED: SendFailure = {
  message: 'Google is rate limiting right now.',
  action: 'retry',
}

export function describeSendFailure(error: unknown): SendFailure {
  switch (codeOf(error)) {
    case 'FORBIDDEN':
      return RECONNECT
    case 'UNAUTHORIZED':
    case 'PRECONDITION_FAILED':
      return {
        message: 'Holi is not connected to Google. Reconnect in vault settings.',
        action: 'reconnect',
      }
    case 'TOO_MANY_REQUESTS':
      return RATE_LIMITED
  }

  const message = error instanceof Error ? error.message : ''
  if (/permission|scope|insufficient/i.test(message)) return RECONNECT
  if (/rate limit/i.test(message)) return RATE_LIMITED
  return {
    message: message === '' ? 'That didn’t send. Your message is still here.' : message,
    // Deliberately not `retry`. **Never auto-retry a send**, and never invite a
    // one-click retry for a failure nobody has diagnosed: the failure mode of a
    // send is a duplicate arriving at a real person, not a message lost.
    action: null,
  }
}
