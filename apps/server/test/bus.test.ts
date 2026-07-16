import { describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'

describe('emitMembership', () => {
  it('emits on a user-keyed channel — the one key a vault-scoped stream cannot have (D51)', () => {
    const bus = createBus()
    const seen: unknown[] = []
    bus.on('user:user-1', (e) => seen.push(e))
    bus.emitMembership('user-1', { type: 'joined' })
    expect(seen).toEqual([{ type: 'joined' }])
  })

  it('carries no vaultId — the envelope has it, and two copies is two chances to disagree (D50)', () => {
    const bus = createBus()
    let received: unknown
    bus.on('user:user-1', (e) => (received = e))
    bus.emitMembership('user-1', { type: 'joined' })
    expect(received).toEqual({ type: 'joined' })
  })

  it('does not reach another user', () => {
    const bus = createBus()
    const seen: unknown[] = []
    bus.on('user:user-2', (e) => seen.push(e))
    bus.emitMembership('user-1', { type: 'left' })
    expect(seen).toEqual([])
  })
})
