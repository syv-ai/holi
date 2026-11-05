import { describe, expect, it, vi } from 'vitest'
import type { CapabilityTable, PluginCtx } from '../../../main/plugin-api'
import type { SessionStore } from '../main/session-store'

const keychain = vi.hoisted(() => ({ stores: 0 }))
vi.mock('../main/electron', () => ({
  createKeychainSessionStore: (): SessionStore => {
    keychain.stores++
    return { read: async () => null, write: async () => {}, clear: async () => {} }
  },
}))

const { bookingMain } = await import('../main')

describe('booking main', () => {
  it('keeps one sign-in for the machine across vault switches', async () => {
    const tables: CapabilityTable[] = []
    const start = (remote: string) =>
      bookingMain.activate?.({
        remote,
        userData: '/user-data',
        register: (_ns: readonly string[], table: CapabilityTable) => (
          tables.push(table),
          () => {}
        ),
        call: vi.fn(),
      } as unknown as PluginCtx)
    await start('owner/a')
    await start('owner/b')
    expect(tables).toHaveLength(2)
    // A second vault reuses the first one's sign-in, so a login started in
    // one can be finished in the other and refreshes never overlap.
    expect(keychain.stores).toBe(1)
  })
})
