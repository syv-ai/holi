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
