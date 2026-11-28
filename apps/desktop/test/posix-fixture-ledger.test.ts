import { access, rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { posixFixtureLedger } from './fixtures/posix-fixture-ledger'

const { scanFailure } = vi.hoisted(() => ({
  scanFailure: Object.assign(new Error('process scan timed out'), { code: 'ETIMEDOUT' }),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: () => {
    throw scanFailure
  },
}))

describe('posix fixture ledger', () => {
  it('reports a failed ancestry scan only after retained cleanup, preserving evidence', async () => {
    const ledger = await posixFixtureLedger('holi-posix-ledger-diagnostic-')
    let drained = false
    let closeOutput!: () => void
    const output = new Promise<void>((resolve) => {
      closeOutput = resolve
    })
    try {
      const identify = ledger.retain(
        999_999,
        async () => {
          drained = true
        },
        output,
        'test-control',
      )
      expect(identify).not.toThrow()
      let settled = false
      const reaped = ledger.reap().finally(() => {
        settled = true
      })
      const failure = expect(reaped).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [scanFailure],
      })
      await Promise.resolve()
      expect(drained).toBe(true)
      expect(settled).toBe(false)
      closeOutput()
      await failure
      await expect(access(ledger.root)).resolves.toBeUndefined()
    } finally {
      closeOutput()
      await rm(ledger.root, { recursive: true, force: true })
    }
  })
})
