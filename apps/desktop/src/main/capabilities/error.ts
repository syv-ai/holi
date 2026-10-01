/** A refusal with a kind a door can map: the router to a tRPC code, the CLI to
 *  a line on stderr. FORBIDDEN stays distinct from NOT_FOUND so an app can
 *  tell "you may not" from "it is not there". UNAVAILABLE is "not here, not
 *  now": no Google account, GitHub unreachable. */
export class CapabilityError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message)
  }
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
