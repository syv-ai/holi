/**
 * How the Google screens read a failed call: the one place the refusal codes
 * main puts on an error, and the prose fallbacks for an error that arrives
 * without one, are turned into what a person can act on.
 */

const NOT_CONNECTED = /not connected|connect Google|no longer valid|not configured/i
const NEEDS_SCOPE = 'Holi needs new Google permissions for this. Reconnect Google in settings.'
const NOT_CONNECTED_MESSAGE = 'Google isn’t connected. Connect it in vault settings.'
const RATE_LIMITED = 'Google is rate limiting. Try again in a moment.'

/**
 * tRPC's verdict, as `ipcLink` rebuilt it.
 *
 * `main/trpc-call.ts` puts main's code on the envelope and `ipc-link.ts` lands
 * it on `err.data.code`, which is where tRPC's own callers already look.
 */
export function codeOf(err: unknown): string | null {
  const data = (err as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : null
}

/** The error's own words, or `fallback` when it has none. */
export function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback
}

/** A missing or expired connection: a state with an obvious next action, not
 *  an error to apologise for. */
export function isDisconnected(err: unknown): boolean {
  const code = codeOf(err)
  const message = err instanceof Error ? err.message : ''
  return code === 'UNAUTHORIZED' || code === 'PRECONDITION_FAILED' || NOT_CONNECTED.test(message)
}

/**
 * Why a write did not stick, in terms the person can act on.
 *
 * The scope case is singled out: it is the likeliest, the user can fix it, and
 * its symptom is otherwise silence (mail loads, only writes fail).
 *
 * **The code first, the prose second.** Google's capabilities map
 * `GoogleApiError.code` onto a refusal code, so this does not read Google's
 * sentences. The regexes are the fallback for an error that arrives without a
 * code.
 */
export function explainWriteFailure(err: unknown): string {
  switch (codeOf(err)) {
    case 'FORBIDDEN':
      return NEEDS_SCOPE
    case 'UNAUTHORIZED':
    case 'PRECONDITION_FAILED':
      return NOT_CONNECTED_MESSAGE
    case 'TOO_MANY_REQUESTS':
    case 'RATE_LIMITED':
      return RATE_LIMITED
  }
  const message = err instanceof Error ? err.message : ''
  if (/permission|scope|insufficient/i.test(message)) return NEEDS_SCOPE
  if (NOT_CONNECTED.test(message)) return NOT_CONNECTED_MESSAGE
  if (/rate limit/i.test(message)) return RATE_LIMITED
  return message === '' ? 'That didn’t stick. Try again.' : message
}
