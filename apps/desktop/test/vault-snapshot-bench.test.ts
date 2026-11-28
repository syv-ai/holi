import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBenchRpc } from '../scripts/vault-snapshot-bench-rpc'
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

  it('detects changed file bodies when the snapshot metadata is unchanged', async () => {
    let body = 'before'
    const host = {
      invalidate: vi.fn(),
      reconcile: vi.fn(),
      snapshot: vi.fn(),
      scanClaimsFor: vi.fn(async () => []),
    }
    const send = vi.fn()
    const adapter = createSnapshotBenchAdapter({
      mode: 'candidate',
      remote: vault.remote,
      getVault: () => vault,
      host,
      send,
      refresh: vi.fn(),
      fingerprint: async () => body,
    })
    await adapter.onSnapshot(snapshot())
    body = 'after, with restored metadata'
    await adapter.onSnapshot(snapshot())
    expect(send).toHaveBeenCalledTimes(2)
    expect(adapter.metrics().sent).toBe(2)
  })

  it('discards a candidate fingerprint result after the vault changes during its await', async () => {
    let current: { remote: string; root: string } | null = vault
    let resolveFingerprint!: (value: string) => void
    const host = {
      invalidate: vi.fn(),
      reconcile: vi.fn(),
      snapshot: vi.fn(),
      scanClaimsFor: vi.fn(async () => []),
    }
    const send = vi.fn()
    const adapter = createSnapshotBenchAdapter({
      mode: 'candidate',
      remote: vault.remote,
      getVault: () => current,
      host,
      send,
      refresh: vi.fn(),
      fingerprint: () => new Promise((resolve) => (resolveFingerprint = resolve)),
    })
    const pending = adapter.onSnapshot(snapshot())
    current = { remote: 'other/vault', root: '/tmp/other' }
    resolveFingerprint('fingerprint')
    await pending
    expect(send).not.toHaveBeenCalled()
    expect(host.invalidate).not.toHaveBeenCalled()
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

  it('keeps plugin snapshot contents current even when an identical renderer push is suppressed', async () => {
    const { adapter, host } = fixture()
    const current = snapshot(['a'])
    await adapter.onSnapshot(current)
    await adapter.onSnapshot(current)
    expect(host.snapshot).toHaveBeenLastCalledWith(vault.remote, current)
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

const preload = vi.hoisted(() => ({
  bridge: null as unknown as Window['holi'],
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: Window['holi']) => {
      preload.bridge = bridge
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      preload.listeners.set(channel, listener)
    },
  },
  webUtils: {},
}))

describe('benchmark production push and RPC contracts', () => {
  it('delivers remote-tagged watcher contents over the production preload and unsubscribes', async () => {
    await import('../src/preload/index')
    const received: unknown[] = []
    const off = preload.bridge.vault.onSnapshot((event) => received.push(event))
    const original = snapshot(['old'])
    const replacement = snapshot(['new'])
    const publish = createSnapshotBenchAdapter({
      mode: 'baseline',
      remote: vault.remote,
      getVault: () => null,
      host: fixture().host,
      refresh: () => {},
      send: (payload) => preload.listeners.get('vault:snapshot')!(null, payload),
    })
    await publish.onSnapshot(original)
    await publish.onSnapshot(replacement)
    preload.listeners.get('vault:snapshot')!(null, { remote: 'other/vault', snapshot: original })
    expect(received).toEqual([
      { remote: vault.remote, snapshot: original },
      { remote: vault.remote, snapshot: replacement },
      { remote: 'other/vault', snapshot: original },
    ])
    off()
    await publish.onSnapshot(original)
    expect(received).toHaveLength(3)
  })

  it('reads current snapshot and disk contents only for the requested benchmark remote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-bench-rpc-'))
    let current = snapshot(['old'])
    const rpc = createBenchRpc({ root, remote: vault.remote, getSnapshot: () => current })
    const query = (path: string, remote = vault.remote) =>
      rpc({ path, input: { remote, path: 'note.md' } })
    try {
      await writeFile(join(root, 'note.md'), 'before')
      expect(await query('notes.read')).toEqual({ ok: true, data: 'before' })
      current = snapshot(['replacement'])
      await writeFile(join(root, 'note.md'), 'watcher update')
      expect(await query('vaults.snapshot')).toEqual({ ok: true, data: current })
      expect(await query('notes.read')).toEqual({ ok: true, data: 'watcher update' })
      for (const path of ['vaults.snapshot', 'notes.read', 'files.read', 'vaults.refresh'])
        expect(await query(path, 'other/vault')).toMatchObject({ ok: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
