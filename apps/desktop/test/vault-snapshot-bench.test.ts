import { describe, expect, it, vi } from 'vitest'
import { createSnapshotBenchAdapter } from '../scripts/vault-snapshot-bench-adapter'

const vault = { remote: 'bench/snapshot', root: '/tmp/bench' }
const snapshot = (dirs: string[] = ['a'], claimed: Record<string, unknown> = {}) =>
  ({
    docs: [],
    dirs,
    claimed,
  }) as never

function fixture(mode: 'baseline' | 'candidate' = 'candidate') {
  const calls: string[] = []
  const host = {
    invalidate: vi.fn(() => calls.push('invalidate')),
    reconcile: vi.fn(async () => {
      calls.push('reconcile')
    }),
    snapshot: vi.fn(() => calls.push('snapshot')),
    scanClaimsFor: vi.fn(async () => [{ plugin: 'tasks' }]),
  }
  const send = vi.fn()
  const adapter = createSnapshotBenchAdapter({
    mode,
    remote: vault.remote,
    getVault: () => vault,
    host,
    send,
    refresh: vi.fn(),
  })
  return { adapter, calls, host, send }
}

describe('real snapshot benchmark adapter', () => {
  it('sends the first snapshot and suppresses only an identical serialized repeat', async () => {
    const { adapter, send } = fixture()
    await adapter.onSnapshot(snapshot())
    await adapter.onSnapshot(snapshot())
    expect(send).toHaveBeenCalledTimes(1)
    expect(adapter.metrics().suppressed).toBe(1)
  })

  it('sends forced refresh, changed fields, A-to-B-to-A, and after an epoch', async () => {
    const { adapter, send } = fixture()
    await adapter.onSnapshot(snapshot(['a']))
    await adapter.onSnapshot(snapshot(['a']), true)
    await adapter.onSnapshot(snapshot(['b']))
    await adapter.onSnapshot(snapshot(['a']))
    adapter.epochChanged()
    await adapter.onSnapshot(snapshot(['a']))
    expect(send).toHaveBeenCalledTimes(5)
  })

  it('preserves production per-scan invalidation/reconcile/snapshot ordering', async () => {
    const { adapter, calls, host } = fixture()
    await adapter.onSnapshot(snapshot())
    const before = adapter.metrics()
    await adapter.onSnapshot(snapshot())
    expect(before.pluginCallbacks).toHaveLength(3)
    expect(adapter.metrics().pluginCallbacks).toHaveLength(6)
    expect(calls).toEqual([
      'invalidate',
      'reconcile',
      'snapshot',
      'invalidate',
      'reconcile',
      'snapshot',
    ])
    expect(host.invalidate).toHaveBeenCalledTimes(2)
    expect(host.reconcile).toHaveBeenCalledTimes(2)
    expect(host.snapshot).toHaveBeenCalledTimes(2)
  })

  it('suppresses equal candidate sends only; baseline always sends', async () => {
    const { adapter, send } = fixture('baseline')
    await adapter.onSnapshot(snapshot())
    await adapter.onSnapshot(snapshot())
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('resets measured counters without changing delivery epochs', async () => {
    const { adapter, send, host } = fixture()
    await adapter.onSnapshot(snapshot())
    const epoch = adapter.metrics().presentationEpoch
    adapter.resetMetrics()
    expect(adapter.metrics()).toMatchObject({ scans: 0, sent: 0, suppressed: 0, payloadBytes: 0 })
    expect(adapter.metrics().presentationEpoch).toBe(epoch)
    await adapter.onSnapshot(snapshot())
    expect(send).toHaveBeenCalledTimes(1)
    expect(adapter.metrics().suppressed).toBe(1)
    expect(host.snapshot).toHaveBeenCalledTimes(2)
  })
})
