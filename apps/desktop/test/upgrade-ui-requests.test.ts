import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureUpgradeUiRequests,
  observeUpgradeUiRequests,
} from '../scripts/upgrade-ui-requests.mjs'

// Electron's registration contract: receiver-bound, one handler per channel,
// duplicate registrations throw; invoke calls that handler with event and arguments.
function ipcFixture() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = {
    handle(channel: string, listener: (...args: any[]) => any) {
      if (this !== ipc) throw new Error('invalid receiver')
      if (handlers.has(channel)) throw new Error('duplicate handler')
      handlers.set(channel, listener)
    },
  }
  return {
    ipc,
    handler: (channel: string) => handlers.get(channel)!,
    invoke: (channel: string, receiver: unknown, ...args: unknown[]) =>
      handlers.get(channel)!.apply(receiver, args),
  }
}
const remote = 'fixture-upgrade-565/synthetic'
const operation = (name = 'google.status', vault = remote) => ({
  path: 'cap.run',
  type: 'mutation',
  input: { remote: vault, name },
})

describe('hosted upgrade UI diagnostics', () => {
  it('observes the cap.run wire contract and correlates the very first startup request', async () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const envelope = {
      ok: true,
      data: { account: { email: 'private@example.invalid' }, needsReconnect: true },
    }
    ipc.handle('holi:trpc', async () => envelope)
    expect(await invoke('holi:trpc', null, {}, operation())).toBe(envelope)
    expect(snapshot()).toEqual([
      {
        capability: 'google.status',
        fixtureVaultMatch: true,
        result: 'success',
        accountPresent: true,
        needsReconnect: true,
      },
    ])
    await invoke('holi:trpc', null, {}, operation('google.allAccounts', 'another/vault'))
    expect(snapshot()[1]).toMatchObject({
      capability: 'google.allAccounts',
      fixtureVaultMatch: false,
    })
  })

  it('preserves unrelated registration, receiver, sync return and throw contracts', () => {
    const { ipc, handler, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const native = function (this: unknown, event: unknown, ...args: unknown[]) {
      return { receiver: this, event, args }
    }
    expect(ipc.handle('native:dialog', native)).toBeUndefined()
    expect(handler('native:dialog')).toBe(native)
    expect(() => ipc.handle('native:dialog', native)).toThrow()
    const receiver = {},
      event = {},
      extra = {}
    expect(invoke('native:dialog', receiver, event, extra)).toEqual({
      receiver,
      event,
      args: [extra],
    })
    ipc.handle('holi:trpc', native)
    const unrelated = { path: 'vaults.open', input: { remote } }
    expect(invoke('holi:trpc', receiver, event, unrelated, extra)).toEqual({
      receiver,
      event,
      args: [unrelated, extra],
    })
    invoke('holi:trpc', receiver, event, operation('google.connect'))
    invoke('holi:trpc', receiver, event, { path: 'google.status', input: { remote } })
    expect(snapshot()).toEqual([])
  })

  it('distinguishes envelope failures, throws, rejections and pending requests without retaining errors', async () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const secret = 'token=/private/credentials email@example.invalid'
    const failure = new Error(secret)
    const rejected = Promise.reject(failure)
    const pending = new Promise(() => {})
    const envelope = { ok: false, message: secret, code: 'NOT_FOUND' }
    const values = [envelope, { ...envelope, code: secret }, failure, rejected, pending]
    const receiver = {},
      event = {}
    ipc.handle(
      'holi:trpc',
      function (this: unknown, received: unknown, _op: unknown, extra: unknown) {
        expect(this).toBe(receiver)
        expect(received).toBe(event)
        expect(extra).toBe(event)
        const value = values.shift()
        if (value === failure) throw failure
        return value
      },
    )
    const request = () => invoke('holi:trpc', receiver, event, operation(), event)
    expect(request()).toBe(envelope)
    request()
    let thrown
    try {
      request()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
    const returned = request()
    expect(returned).toBe(rejected)
    await expect(returned).rejects.toBe(failure)
    expect(request()).toBe(pending)
    expect(snapshot()).toEqual([
      {
        capability: 'google.status',
        fixtureVaultMatch: true,
        result: 'envelope-error',
        code: 'NOT_FOUND',
      },
      {
        capability: 'google.status',
        fixtureVaultMatch: true,
        result: 'envelope-error',
        code: 'other',
      },
      { capability: 'google.status', fixtureVaultMatch: true, result: 'throw' },
      { capability: 'google.status', fixtureVaultMatch: true, result: 'rejection' },
      { capability: 'google.status', fixtureVaultMatch: true, result: 'pending' },
    ])
    expect(JSON.stringify(snapshot())).not.toContain(secret)
  })

  it('bounds diagnostics without suppressing later requests', () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    let effects = 0
    ipc.handle('holi:trpc', () => {
      effects++
      return { ok: true, data: { current: 'private-sub' } }
    })
    for (let i = 0; i < 30; i++) invoke('holi:trpc', null, {}, operation('google.allAccounts'))
    expect(effects).toBe(30)
    expect(snapshot()).toHaveLength(20)
    expect(snapshot()[0]).toEqual({
      capability: 'google.allAccounts',
      fixtureVaultMatch: true,
      result: 'success',
      currentAccountPresent: true,
    })
    expect(JSON.stringify(snapshot())).not.toContain('private-sub')
  })

  it('persists diagnostics for a 120s panel timeout and survives an unavailable inspector', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holi-ui-diagnostics-'))
    try {
      const { ipc, invoke } = ipcFixture()
      const snapshot = observeUpgradeUiRequests(ipc, remote)
      ipc.handle('holi:trpc', () => ({ ok: false, code: 'FORBIDDEN', message: 'withheld' }))
      invoke('holi:trpc', null, {}, operation())
      const timeout = new Error('panel deadline')
      const receipt: Record<string, any> = {
        timedOut: { phase: 'visible-google-connections', milliseconds: 120_000 },
      }
      const path = join(directory, 'result.json')
      const persist = () => writeFile(path, JSON.stringify(receipt), { mode: 0o600 })
      const workflow = async () => {
        try {
          throw timeout
        } catch (error) {
          await captureUpgradeUiRequests({ execute: async () => snapshot(), receipt, persist })
          throw error
        }
      }
      await expect(workflow()).rejects.toBe(timeout)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        timedOut: { milliseconds: 120_000 },
        uiCapabilityCapture: 'captured',
        uiCapabilityRequests: [
          { result: 'envelope-error', code: 'FORBIDDEN', fixtureVaultMatch: true },
        ],
      })
      await captureUpgradeUiRequests({
        execute: async () => {
          throw new Error('private transport error')
        },
        receipt,
        persist,
      })
      const saved = JSON.parse(await readFile(path, 'utf8'))
      expect(saved.uiCapabilityCapture).toBe('unavailable')
      expect(saved.uiCapabilityRequests).toHaveLength(1)
      expect(JSON.stringify(saved)).not.toContain('private transport error')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
