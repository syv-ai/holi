/** A refusal with a kind a door can map: the router to a tRPC code, the CLI to
 *  a line on stderr. FORBIDDEN stays distinct from NOT_FOUND so an app can
 *  tell "you may not" from "it is not there". UNAVAILABLE is "not here, not
 *  now": no Google account, GitHub unreachable. UNAUTHORIZED is a connection
 *  that has to be made again, and RATE_LIMITED a service asking to be left
 *  alone for a while: each has a different thing the person can do. */
export class CapabilityError extends Error {
  constructor(
    readonly code:
      'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'UNAVAILABLE' | 'UNAUTHORIZED' | 'RATE_LIMITED',
    message: string,
  ) {
    super(message)
  }
}

/** The tRPC code a refusal crosses to the renderer with. */
export function trpcCodeOf(
  code: CapabilityError['code'],
):
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'UNAUTHORIZED'
  | 'TOO_MANY_REQUESTS' {
  if (code === 'UNAVAILABLE') return 'PRECONDITION_FAILED'
  if (code === 'RATE_LIMITED') return 'TOO_MANY_REQUESTS'
  return code
}

/** A GitHub or Google failure, as a refusal the caller can render. */
export async function unavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof CapabilityError) throw err
    throw new CapabilityError('UNAVAILABLE', (err as Error).message)
  }
}
