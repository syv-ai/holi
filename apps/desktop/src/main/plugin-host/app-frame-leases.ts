import { randomBytes } from 'node:crypto'
import { isAppBundlePath } from '@holi/shared'
import type { AppFrameLease, AppFrameLeases } from '../plugin-api'

const MAX_LEASES = 256

/** Main-process authority for one presented app document and its resources. */
export function createAppFrameLeases(): AppFrameLeases {
  const entries = new Map<string, AppFrameLease>()

  const revoke = (lease: AppFrameLease): void => {
    if (entries.get(lease.token) === lease) entries.delete(lease.token)
  }

  return {
    issue(input) {
      if (entries.size >= MAX_LEASES) throw new Error('too many live app frame leases')
      if (!isAppBundlePath(input.bundle)) throw new Error('invalid app frame lease bundle')
      const token = randomBytes(24).toString('hex')
      let documentClaimed = false
      const lease: AppFrameLease = {
        ...input,
        token,
        nonce: randomBytes(24).toString('hex'),
        claimDocument() {
          if (documentClaimed || entries.get(token) !== lease) return false
          documentClaimed = true
          return true
        },
        valid(window) {
          return (
            entries.get(token) === lease &&
            window === input.window &&
            !window.isDestroyed() &&
            input.current()
          )
        },
      }
      entries.set(token, lease)
      return lease
    },
    resolve(token, window) {
      const lease = entries.get(token) ?? null
      return lease !== null && lease.valid(window) ? lease : null
    },
    validate({ token, nonce, window, remote, bundle }) {
      const lease = entries.get(token) ?? null
      return lease !== null &&
        lease.nonce === nonce &&
        lease.remote === remote &&
        lease.bundle === bundle &&
        lease.valid(window)
        ? lease
        : null
    },
    revoke,
    release(token, remote, bundle) {
      const lease = entries.get(token)
      if (lease === undefined || lease.remote !== remote || lease.bundle !== bundle) return false
      revoke(lease)
      return true
    },
    revokeActivation(remote, activation) {
      for (const lease of entries.values()) {
        if (lease.remote === remote && lease.activation === activation) revoke(lease)
      }
    },
    revokeRemote(remote) {
      for (const lease of entries.values()) if (lease.remote === remote) revoke(lease)
    },
    revokeAll() {
      entries.clear()
    },
  }
}
