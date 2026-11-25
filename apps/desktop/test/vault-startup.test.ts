import { describe, expect, it } from 'vitest'
import { startRegisteredVaults } from '../src/main/vault/startup'

describe('startRegisteredVaults', () => {
  it('continues after a vault fails and does not select a vault', async () => {
    const started: string[] = []
    const failures: string[] = []
    let selected: string | null = null

    await startRegisteredVaults(
      [{ remote: 'owner/first' }, { remote: 'owner/broken' }, { remote: 'owner/last' }],
      async (remote) => {
        started.push(remote)
        if (remote === 'owner/broken') throw new Error('unavailable')
        return remote
      },
      (remote) => failures.push(remote),
    )

    expect(started).toEqual(['owner/first', 'owner/broken', 'owner/last'])
    expect(failures).toEqual(['owner/broken'])
    expect(selected).toBeNull()
  })
})
