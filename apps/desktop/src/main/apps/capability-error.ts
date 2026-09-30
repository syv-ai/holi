/** A refusal with a kind a door can map: the router to a tRPC code, the CLI to
 *  a line on stderr. FORBIDDEN stays distinct from NOT_FOUND so an app can
 *  tell "you may not" from "it is not there". */
export class CapabilityError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
  }
}
