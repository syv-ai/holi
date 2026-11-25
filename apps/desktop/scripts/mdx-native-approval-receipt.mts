import assert from 'node:assert/strict'
import { fixtureOrigins } from './mdx-native-fixture-constants.mts'
import type { observeMdxNativeNetwork } from './mdx-native-network-observation.js'
type Receipt = Pick<ReturnType<typeof observeMdxNativeNetwork>['network'], 'sequence' | 'events'>

export function assertMdxNativeApprovalOrder({ sequence, events }: Receipt) {
  assert(Array.isArray(events) && sequence === events.length, 'Incomplete native event receipt')
  const history: ['approval' | 'revocation', string][] = []
  const everApproved = new Set()
  const active = new Set()
  for (const [index, { seq, origin, kind }] of events.entries()) {
    assert.equal(seq, index + 1, 'Non-contiguous main-process event sequence')
    if (!fixtureOrigins.some((expected) => expected === origin)) continue // Checked by the aggregate traffic tripwire.
    if (kind === 'approval') {
      everApproved.add(origin)
      active.add(origin)
      history.push([kind, origin])
    } else if (kind === 'revocation') {
      active.delete(origin)
      history.push([kind, origin])
    } else {
      // A handshake or response can settle after revocation. It is not a new
      // contact; the initiating TLS/HTTP operations were checked when observed.
      const settlement = kind === 'verifiedPeer' || kind === 'httpResponses'
      assert(
        (settlement ? everApproved : active).has(origin),
        `${kind} for ${origin} at sequence ${seq} had no preceding active saved approval`,
      )
    }
  }
  return history
}
