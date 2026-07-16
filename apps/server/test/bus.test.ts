import { describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'

describe('emitMembership', () => {
  it('emits on a user-keyed channel — the one key a vault-scoped stream cannot have (D51)', () => {
    const bus = createBus()
    const seen: unknown[] = []
    bus.on('user:user-1', (e) => seen.push(e))
    bus.emitMembership('user-1', { type: 'joined', vaultId: 'v1' })
    expect(seen).toEqual([{ type: 'joined', vaultId: 'v1' }])
  })

  // Unlike docs/tasks/presence/reminders, the key here names the *user*, so the vault is
  // not recoverable from it. A listener told "you joined" with no vaultId cannot act.
  it('carries the vaultId in the payload, because the key cannot supply it', () => {
    const bus = createBus()
    let received: { vaultId?: string } | undefined
    bus.on('user:user-1', (e) => (received = e))
    bus.emitMembership('user-1', { type: 'joined', vaultId: 'v1' })
    expect(received?.vaultId).toBe('v1')
  })

  it('does not reach another user', () => {
    const bus = createBus()
    const seen: unknown[] = []
    bus.on('user:user-2', (e) => seen.push(e))
    bus.emitMembership('user-1', { type: 'left', vaultId: 'v1' })
    expect(seen).toEqual([])
  })
})
