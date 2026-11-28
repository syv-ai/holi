import { createHash } from 'node:crypto'

/** A stable, collision-resistant identity for one vault's Google grant. */
export function googleConnectionId(remote: string, clientId: string, sub: string): string {
  if (!remote || !clientId || !sub)
    throw new Error('Google connection identity requires a vault, client, and account')
  return createHash('sha256')
    .update(JSON.stringify([remote, clientId, sub]))
    .digest('hex')
}
