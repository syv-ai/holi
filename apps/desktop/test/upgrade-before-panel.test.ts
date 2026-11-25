import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  waitForBeforePanel,
  captureUpgradeUiRequests,
  observeUpgradeUiRequests,
} from '../scripts/upgrade-before-panel.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
)

type Scenario =
  | 'ready'
  | 'ambiguous'
  | 'loading'
  | 'window-too-large'
  | 'image-too-large'
  | 'window-changed'
  | 'capture-failed'
  | 'transport-too-large'
  | 'existing-output'

async function fixture(scenario: Scenario = 'ready') {
  const directory = await mkdtemp(join(tmpdir(), 'holi-before-panel-'))
  const failure = new Error('panel deadline reached')
  const receipt: { before: Record<string, unknown>; timedOut?: { phase: string } } = { before: {} }
  let captures = 0
  let encodes = 0
  let changed = false
  const window = {
    id: 7,
    isDestroyed: () => false,
    webContents: { isLoading: () => scenario === 'loading' },
    getContentBounds: () => ({ width: scenario === 'window-too-large' ? 50_000 : 1, height: 1 }),
    capturePage: async () => {
      captures++
      if (scenario === 'capture-failed') throw new Error('capture unavailable')
      changed = scenario === 'window-changed'
      return {
        getSize: () => ({ width: scenario === 'image-too-large' ? 50_000 : 1, height: 1 }),
        toPNG: () => {
          encodes++
          return png
        },
      }
    },
  }
  const other = { ...window, id: 8 }
  const electron = {
    BrowserWindow: {
      getAllWindows: () => (scenario === 'ambiguous' || changed ? [window, other] : [window]),
    },
    screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
  }
  const output = join(directory, 'before-panel-unasserted.png')
  if (scenario === 'existing-output') await writeFile(output, 'retained evidence')
  return {
    directory,
    failure,
    receipt,
    output,
    captures: () => captures,
    encodes: () => encodes,
    observe: (connected: unknown) =>
      waitForBeforePanel({
        probe: async () => ({
          connected,
          headingVisible: true,
          unsafe: 'untrusted payload',
          unknownFlag: true,
        }),
        wait: async (_name: string, condition: () => Promise<unknown>) => {
          if (await condition()) return
          receipt.timedOut = { phase: 'visible-google-connections' }
          throw failure
        },
        execute: async (expression: string) => {
          const result = await vm.runInNewContext(expression, {
            require: (name: string) => {
              if (name !== 'electron') throw new Error('unexpected module')
              return electron
            },
          })
          // Model an oversized transport response separately from the Electron capture contract.
          return scenario === 'transport-too-large' && result
            ? { ...result, png: 'A'.repeat(24 * 1024 * 1024) }
            : result
        },
        evidenceDirectory: directory,
        receipt,
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

describe('before-panel observation', () => {
  it('accepts explicit connection evidence without creating a failure image', async () => {
    const app = await fixture()
    try {
      await app.observe(true)
      expect(app.receipt.before.uiProbe).toMatchObject({ connected: true })
      expect(await readdir(app.directory)).toEqual([])
      expect(app.captures()).toBe(0)
    } finally {
      await app.close()
    }
  })

  it.each([false, 'true', { value: true }])(
    'does not accept a truthy probe object with connected=%j',
    async (connected) => {
      const app = await fixture()
      try {
        await expect(app.observe(connected)).rejects.toBe(app.failure)
        expect(app.receipt.before.uiProbe).not.toMatchObject({ connected: true })
        expect(app.receipt.before.uiProbe).not.toHaveProperty('unknownFlag')
        expect(JSON.stringify(app.receipt)).not.toContain('untrusted payload')
        expect(app.receipt.before.failureImage).toMatchObject({
          googleConnectionsPanelAsserted: false,
        })
        expect(await readFile(app.output)).toEqual(png)
        if (process.platform !== 'win32') expect((await stat(app.output)).mode & 0o077).toBe(0)
      } finally {
        await app.close()
      }
    },
  )

  it.each([
    'ambiguous',
    'loading',
    'window-too-large',
    'image-too-large',
    'window-changed',
    'capture-failed',
    'transport-too-large',
    'existing-output',
  ] as const)(
    'retains the original failure and refuses unsafe/unavailable evidence: %s',
    async (scenario) => {
      const app = await fixture(scenario)
      try {
        await expect(app.observe(false)).rejects.toBe(app.failure)
        expect(app.receipt.before.failureImage).toMatchObject({ outcome: 'unavailable' })
        if (scenario === 'existing-output')
          expect(await readFile(app.output, 'utf8')).toBe('retained evidence')
        else await expect(stat(app.output)).rejects.toMatchObject({ code: 'ENOENT' })
        if (['ambiguous', 'loading', 'window-too-large'].includes(scenario))
          expect(app.captures()).toBe(0)
        if (scenario === 'image-too-large') expect(app.encodes()).toBe(0)
      } finally {
        await app.close()
      }
    },
  )
})

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
    expect(snapshot()).toHaveLength(1)
    expect(snapshot()[0]).toMatchObject({
      capability: 'google.status',
      fixtureVaultMatch: true,
      result: 'success',
      accountPresent: true,
      needsReconnect: true,
    })
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
    expect(snapshot().map(({ result, code }) => ({ result, code }))).toEqual([
      { result: 'envelope-error', code: 'NOT_FOUND' },
      { result: 'envelope-error', code: 'other' },
      { result: 'throw', code: undefined },
      { result: 'rejection', code: undefined },
      { result: 'pending', code: undefined },
    ])
    expect(JSON.stringify(snapshot())).not.toContain(secret)
  })

  it.each(['google.status', 'google.allAccounts'])(
    'classifies the exact unavailable-method refusal for %s in the injected observer',
    async (capability) => {
      const { ipc, invoke } = ipcFixture()
      // The signed producer installs the observer from its serialized function body.
      const install = new Function(`return (${observeUpgradeUiRequests.toString()})`)()
      const snapshot = install(ipc, remote)
      const envelope = {
        ok: false,
        code: 'BAD_REQUEST',
        message: `no such method: ${capability}`,
      }
      ipc.handle('holi:trpc', async () => envelope)
      expect(await invoke('holi:trpc', null, {}, operation(capability))).toBe(envelope)
      expect(snapshot()).toHaveLength(1)
      expect(snapshot()[0]).toMatchObject({
        capability,
        fixtureVaultMatch: true,
        result: 'envelope-error',
        code: 'BAD_REQUEST',
        refusalClass: 'method-unavailable',
      })
    },
  )

  it('keeps other refusals distinct without serializing private error fields', () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const secret = 'token=/private/credentials email@example.invalid'
    const messages = [
      'no such method: google.allAccounts',
      'no such method: google.status ',
      `${secret} no such method: google.status`,
      `no such method: google.status ${secret}`,
      'params are not JSON',
      secret,
      { message: secret },
      undefined,
    ]
    let envelope: Record<string, unknown>
    ipc.handle('holi:trpc', () => envelope)
    for (const message of messages) {
      envelope = {
        ok: false,
        code: 'BAD_REQUEST',
        message,
        cause: { message: secret },
        stack: secret,
        identity: secret,
        token: secret,
        path: secret,
        payload: secret,
      }
      expect(invoke('holi:trpc', null, {}, operation())).toBe(envelope)
    }
    expect(snapshot()).toHaveLength(messages.length)
    for (const record of snapshot())
      expect(record).toMatchObject({
        capability: 'google.status',
        fixtureVaultMatch: true,
        result: 'envelope-error',
        code: 'BAD_REQUEST',
        refusalClass: 'other',
      })
    envelope = { ok: false, code: 'FORBIDDEN', message: 'no such method: google.status' }
    expect(invoke('holi:trpc', null, {}, operation())).toBe(envelope)
    expect(snapshot().at(-1)).toMatchObject({
      capability: 'google.status',
      fixtureVaultMatch: true,
      result: 'envelope-error',
      code: 'FORBIDDEN',
    })
    expect(JSON.stringify(snapshot())).not.toContain(secret)
  })

  it('records only matching vault.open lifecycle and orders it against Google requests', async () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const opened = { ok: true, data: {} }
    ipc.handle('holi:trpc', (_event: unknown, op: any) =>
      op.path === 'vaults.open' ? Promise.resolve(opened) : { ok: true, data: {} },
    )
    invoke(
      'holi:trpc',
      null,
      {},
      { path: 'vaults.open', type: 'mutation', input: { remote: 'other/vault' } },
    )
    const pending = invoke(
      'holi:trpc',
      null,
      {},
      { path: 'vaults.open', type: 'mutation', input: { remote } },
    )
    invoke('holi:trpc', null, {}, operation())
    await pending
    expect(snapshot()).toHaveLength(2)
    expect(snapshot()[0]).toMatchObject({ event: 'vaults.open', result: 'success', startOrder: 1 })
    expect(snapshot()[0].completionOrder).toBeGreaterThan(snapshot()[0].startOrder)
    expect(snapshot()[1]).toMatchObject({
      event: 'google-request',
      capability: 'google.status',
      startOrder: 2,
    })
    expect(JSON.stringify(snapshot())).not.toContain(remote)
  })

  it('orders completion diagnostics across deferred opens and Google requests', async () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    let resolveOpen!: (value: unknown) => void
    let resolveGoogle!: (value: unknown) => void
    const open = new Promise((resolve) => (resolveOpen = resolve))
    const google = new Promise((resolve) => (resolveGoogle = resolve))
    let opens = 0
    let googles = 0
    ipc.handle('holi:trpc', (_event: unknown, op: any) =>
      op.path === 'vaults.open'
        ? ++opens === 1
          ? open
          : Promise.resolve({ ok: true })
        : ++googles === 1
          ? google
          : Promise.resolve({ ok: false }),
    )
    const firstOpen = invoke(
      'holi:trpc',
      null,
      {},
      { path: 'vaults.open', type: 'mutation', input: { remote } },
    )
    const firstGoogle = invoke('holi:trpc', null, {}, operation())
    resolveGoogle({ ok: false })
    await firstGoogle
    const secondGoogle = invoke('holi:trpc', null, {}, operation())
    await secondGoogle
    resolveOpen({ ok: true })
    await firstOpen
    const events = snapshot()
    expect(events.map(({ event }) => event)).toEqual([
      'vaults.open',
      'google-request',
      'google-request',
    ])
    expect(events[0].startOrder).toBeLessThan(events[1].startOrder)
    expect(events[1].completionOrder).toBeLessThan(events[2].startOrder)
    expect(events[2].completionOrder).toBeLessThan(events[0].completionOrder)
  })

  it('bounds vault lifecycle diagnostics together with Google requests', () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    let effects = 0
    ipc.handle('holi:trpc', () => {
      effects++
      return new Promise(() => {})
    })
    for (let i = 0; i < 30; i++)
      invoke('holi:trpc', null, {}, { path: 'vaults.open', type: 'mutation', input: { remote } })
    expect(effects).toBe(30)
    expect(snapshot()).toHaveLength(20)
    expect(snapshot().every(({ result }) => result === 'pending')).toBe(true)
    expect(snapshot().every((record) => !('completionOrder' in record))).toBe(true)
  })

  it('records failed and still-pending vault.open outcomes without retaining errors', async () => {
    const { ipc, invoke } = ipcFixture()
    const snapshot = observeUpgradeUiRequests(ipc, remote)
    const secret = 'token=/private/credentials email@example.invalid'
    const pending = new Promise(() => {})
    let calls = 0
    ipc.handle('holi:trpc', () => (++calls === 1 ? Promise.reject(new Error(secret)) : pending))
    const failed = invoke(
      'holi:trpc',
      null,
      {},
      { path: 'vaults.open', type: 'mutation', input: { remote } },
    )
    await expect(failed).rejects.toThrow(secret)
    invoke('holi:trpc', null, {}, { path: 'vaults.open', type: 'mutation', input: { remote } })
    expect(snapshot().map(({ event, result }) => ({ event, result }))).toEqual([
      { event: 'vaults.open', result: 'rejection' },
      { event: 'vaults.open', result: 'pending' },
    ])
    expect(snapshot()[0].completionOrder).toBeDefined()
    expect(snapshot()[1]).not.toHaveProperty('completionOrder')
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
    expect(snapshot()[0]).toMatchObject({
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
