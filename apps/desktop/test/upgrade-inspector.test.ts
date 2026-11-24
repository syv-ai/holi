import { describe, expect, it } from 'vitest'
import { createOwnedProcesses } from '../scripts/owned-processes.mjs'
import { connectUpgradeInspector } from '../scripts/upgrade-inspector.mjs'

describe('upgrade inspector diagnostics', () => {
  it('reports a bounded Runtime.evaluate timeout without exposing the expression', async () => {
    const owned = createOwnedProcesses()
    const record = owned.start(process.execPath, [
      '--inspect-brk=127.0.0.1:0',
      '-e',
      'setInterval(() => {}, 1000)',
    ])
    let inspector: Awaited<ReturnType<typeof connectUpgradeInspector>> | undefined
    const expression = 'globalThis.secretFixtureExpression; new Promise(() => {})'
    try {
      inspector = await connectUpgradeInspector(record, { timeoutMs: 1500 })
      await inspector.resume()
      await expect(inspector.evaluate(expression)).rejects.toMatchObject({
        details: { method: 'Runtime.evaluate', kind: 'timeout', timeoutMs: 1500 },
        message: expect.not.stringContaining(expression),
      })
    } finally {
      await owned.stop(record)
      inspector?.close()
      await record.exited
      expect(owned.remainingPids).toEqual([])
    }
  }, 10_000)
})
