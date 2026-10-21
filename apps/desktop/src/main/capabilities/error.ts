/** A refusal with a kind a door can map: the router to a tRPC code, the CLI to
 *  a line on stderr. FORBIDDEN stays distinct from NOT_FOUND so an app can
 *  tell "you may not" from "it is not there". UNAVAILABLE is "not here, not
 *  now": no Google account, GitHub unreachable. UNAUTHORIZED is a connection
 *  that has to be made again, and RATE_LIMITED a service asking to be left
 *  alone for a while: each has a different thing the person can do. CONFLICT
 *  is a write that lost a race: the file changed since the caller read it,
 *  or already exists, so it reads again rather than overwrite.
 *
 *  `next` is that thing, for a thrower that knows it better than the code's
 *  own `NEXT_STEP` does: "reconnect Google in vault settings" rather than
 *  "reconnect it". */
export class CapabilityError extends Error {
  constructor(
    readonly code:
      | 'BAD_REQUEST'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'UNAVAILABLE'
      | 'UNAUTHORIZED'
      | 'RATE_LIMITED',
    message: string,
    readonly next?: string,
  ) {
    super(message)
  }
}

/** What to do about a refusal of each kind, when its thrower said nothing more
 *  specific. Written for the agent, which acts on the line it reads: a refusal
 *  that names only the cause leaves it guessing, and its usual guess is to
 *  retry. */
export const NEXT_STEP: Record<CapabilityError['code'], string> = {
  BAD_REQUEST: 'fix the arguments; the usage line says what the command takes',
  FORBIDDEN: 'this is not allowed from here; do not retry, tell the person instead',
  NOT_FOUND: 'check the name or id; list what exists before asking again',
  CONFLICT: 'it changed since it was read; read it again and redo the change on what is there now',
  UNAVAILABLE: 'it needs something that is not there right now; tell the person, do not retry',
  UNAUTHORIZED:
    "the connection has to be made again; ask the person to reconnect it in Holi's vault settings",
  RATE_LIMITED: 'the service asked to be left alone; wait a minute, then make fewer calls',
}

/** The tRPC code a refusal crosses to the renderer with. */
export function trpcCodeOf(
  code: CapabilityError['code'],
):
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNAUTHORIZED'
  | 'TOO_MANY_REQUESTS' {
  if (code === 'UNAVAILABLE' || code === 'CONFLICT') return 'PRECONDITION_FAILED'
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
