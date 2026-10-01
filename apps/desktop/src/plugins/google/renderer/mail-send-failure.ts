/**
 * Why a send or save did not happen, and what the user can do about it.
 *
 * The action is the point: permission failures have a fix the user can
 * perform, rate limits one worth offering, and the rest none, so the text is
 * handed back unchanged.
 *
 * The code first (Google's capabilities map its errors onto refusal codes); the
 * regexes are the fallback for an error without one.
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
    // Deliberately not `retry`: never invite a retry for an undiagnosed send
    // failure, whose risk is a duplicate reaching a real person.
    action: null,
  }
}
