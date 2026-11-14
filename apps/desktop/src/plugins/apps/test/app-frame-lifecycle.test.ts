import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { cap, createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createAppFrameLeases } from '../../../main/plugin-host/app-frame-leases'
import { scanVault } from '../../../main/vault/vault-store'
import { createPluginHost, type OpenVault } from '../../../main/plugin-host/host'
import { serveScheme } from '../../../main/plugin-host/schemes'
import type { PluginCtx } from '../../../main/plugin-api'
import { appsMain } from '../main'
import { leasedAppHost } from '../shared/bundle'

const REMOTE_A = 'ada/a'
const REMOTE_B = 'ada/b'
const BUNDLE = 'Same/Tool.app'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('app frame activation lifetime', () => {
  it('routes real app calls only through the current activation lease', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'holi-app-frame-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'holi-app-frame-b-'))
    roots.push(rootA, rootB)
    for (const root of [rootA, rootB]) {
      await mkdir(join(root, BUNDLE), { recursive: true })
      await writeFile(join(root, BUNDLE, 'index.html'), '<h1>same bundle</h1>')
      await writeFile(join(root, BUNDLE, 'app.yaml'), 'dangerously-allow: [mail]\n')
    }

    const window = { isDestroyed: () => false } as BrowserWindow
    const appFrames = createAppFrameLeases()
    const registry = createCapabilityRegistry()
    let active: OpenVault | null = null
    let pluginHost!: ReturnType<typeof createPluginHost>
    let dispatch!: ReturnType<typeof createCapabilityHost>['dispatch']
    let entered = 0
    let admitGate: {
      release(): void
      promise: Promise<void>
      reached(): void
      waiting: Promise<void>
    } | null = null
    let scanGate: {
      release(): void
      promise: Promise<void>
      reached(): void
      waiting: Promise<void>
    } | null = null
    const makeGate = () => {
      let release!: () => void
      let reached!: () => void
      const promise = new Promise<void>((resolve) => (release = resolve))
      const waiting = new Promise<void>((resolve) => (reached = resolve))
      return { release, promise, reached, waiting }
    }
    const capabilityHost = createCapabilityHost({
      registry,
      rootFor: async (remote) => (remote === REMOTE_A ? rootA : remote === REMOTE_B ? rootB : null),
      active: () => null,
      core: noCoreServices,
      pluginEnabled: async (plugin, root) => (await pluginHost.serving(root)).has(plugin),
      claims: async () => [],
      scan: async (root, claims) => {
        if (scanGate !== null) {
          scanGate.reached()
          await scanGate.promise
        }
        return scanVault(root, claims)
      },
    })
    dispatch = capabilityHost.dispatch
    const proof = {
      info: { id: 'proof', label: 'Proof', default: true },
      activate(ctx: PluginCtx) {
        ctx.register(['proof'], {
          'proof.snapshotWrite': cap({
            doors: ['app'],
            appGrant: 'mail',
            params: (raw) => raw as { value: string },
            run: async (context, params) => {
              await context.snapshot()
              entered += 1
              await writeFile(join(context.root, 'snapshot-writes.txt'), params.value + '\n', {
                flag: 'a',
              })
              return true
            },
          }),
          'proof.write': cap({
            doors: ['app'],
            appGrant: 'mail',
            params: (raw) => raw as { value: string },
            run: async (context, params) => {
              entered += 1
              await writeFile(join(context.root, 'writes.txt'), params.value + '\n', { flag: 'a' })
              return true
            },
          }),
        })
        return () => {}
      },
    }
    const plugins = [appsMain, proof]
    pluginHost = createPluginHost({
      plugins,
      registry,
      appFrames,
      userData: join(rootA, 'user-data'),
      coreSeeds: [],
      active: () => active,
      rootFor: async (remote) => (remote === REMOTE_A ? rootA : remote === REMOTE_B ? rootB : null),
      events: { send: () => {}, listen: () => () => {}, liveRemote: () => REMOTE_A },
      openAppDoor: (opener, remote) =>
        capabilityHost.openAppDoor(
          {
            admit: async (context, grant) => {
              await opener.admit(context, grant)
              if (admitGate !== null) {
                admitGate.reached()
                await admitGate.promise
              }
            },
          },
          remote,
        ),
      route: () => () => {},
      binDir: () => '/bin',
      githubToken: () => null,
      frameOrigin: () => () => {},
      notify: () => false,
      focused: () => false,
      window: () => window,
      readSettings: async () => ({
        ...VAULT_SETTING_DEFAULTS,
        warnings: [],
        plugins: { vault: {}, localOff: [] },
        pluginValues: {},
      }),
      call: async (remote, name, params, beforeInvoke) =>
        (await dispatch({ door: 'ui', remote, name, params, beforeInvoke })).value,
    })
    const vault = (remote: string, root: string): OpenVault => ({
      remote,
      root,
      pause: () => {},
      resume: () => {},
      commitNow: async () => null,
      repo: { head: async () => 'head' },
    })
    const serve = serveScheme(
      { owner: 'apps', scheme: appsMain.schemes![0]! },
      {
        active: () => active,
        runs: async (owner, root) => (await pluginHost.serving(root)).has(owner),
        appFrames,
        windowForRequest: () => window,
      },
    )
    const frameLease = async (remote: string) => {
      const value = (
        await dispatch({
          door: 'ui',
          remote,
          name: 'apps.frameLease',
          params: { bundle: BUNDLE },
        })
      ).value as { token: string; nonce: string }
      const response = await serve(
        new Request(`holi-app://${leasedAppHost(BUNDLE, value.token)}/index.html`),
      )
      expect(response.status).toBe(200)
      return value
    }
    const call = (
      remote: string,
      lease: { token: string; nonce: string },
      value: string,
      method = 'proof.write',
    ) =>
      dispatch({
        door: 'ui',
        remote,
        name: 'apps.call',
        params: { bundle: BUNDLE, method, params: { value }, ...lease },
      })

    active = vault(REMOTE_A, rootA)
    pluginHost.setDisplayed(REMOTE_A)
    await pluginHost.reconcile(active, 'open')
    expect(pluginHost.displayed()).toBe(REMOTE_A)
    expect(pluginHost.failures(REMOTE_A)).toEqual({})
    const leaseA = await frameLease(REMOTE_A)
    const grantStatus = (
      await dispatch({
        door: 'ui',
        remote: REMOTE_A,
        name: 'apps.grants',
        params: { bundle: BUNDLE },
      })
    ).value as { codeHash: string }
    await dispatch({
      door: 'ui',
      remote: REMOTE_A,
      name: 'apps.grant',
      params: { bundle: BUNDLE, codeHash: grantStatus.codeHash, affordances: ['mail'] },
    })
    await call(REMOTE_A, leaseA, 'A')
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(rootA, 'writes.txt'), 'utf8'),
      ),
    ).toBe('A\n')
    await expect(
      import('node:fs/promises').then(({ access }) => access(join(rootB, 'writes.txt'))),
    ).rejects.toThrow()

    const enteredBefore = entered
    await expect(call(REMOTE_A, { ...leaseA, nonce: 'x'.repeat(48) }, 'bad')).rejects.toThrow()
    await expect(call(REMOTE_A, { ...leaseA, token: 'x'.repeat(48) }, 'bad')).rejects.toThrow()
    await expect(
      dispatch({
        door: 'ui',
        remote: REMOTE_A,
        name: 'apps.call',
        params: { bundle: 'Other.app', method: 'proof.write', params: { value: 'bad' }, ...leaseA },
      }),
    ).rejects.toThrow()
    const revokedLease = await frameLease(REMOTE_A)
    await dispatch({
      door: 'ui',
      remote: REMOTE_A,
      name: 'apps.releaseFrameLease',
      params: { bundle: BUNDLE, token: revokedLease.token },
    })
    await expect(call(REMOTE_A, revokedLease, 'bad')).rejects.toThrow()
    expect(entered).toBe(enteredBefore)

    const gate = makeGate()
    admitGate = gate
    const pending = call(REMOTE_A, leaseA, 'stale')
    await gate.waiting
    active = vault(REMOTE_B, rootB)
    pluginHost.setDisplayed(REMOTE_B)
    await pluginHost.reconcile(active, 'open')
    active = vault(REMOTE_A, rootA)
    pluginHost.setDisplayed(REMOTE_A)
    await pluginHost.reconcile(active, 'open')
    gate.release()
    await expect(pending).rejects.toThrow()
    admitGate = null
    expect(entered).toBe(enteredBefore)

    pluginHost.setDisplayed(REMOTE_A)
    const snapshotLease = await frameLease(REMOTE_A)
    const snapshotGate = makeGate()
    scanGate = snapshotGate
    const snapshotPending = call(REMOTE_A, snapshotLease, 'stale-snapshot', 'proof.snapshotWrite')
    await snapshotGate.waiting
    pluginHost.setDisplayed(REMOTE_B)
    pluginHost.setDisplayed(REMOTE_A)
    snapshotGate.release()
    await expect(snapshotPending).rejects.toThrow()
    scanGate = null
    expect(entered).toBe(enteredBefore)
    await expect(
      import('node:fs/promises').then(({ access }) => access(join(rootA, 'snapshot-writes.txt'))),
    ).rejects.toThrow()

    pluginHost.setDisplayed(REMOTE_B)
    const leaseB = await frameLease(REMOTE_B)
    const grantB = (
      await dispatch({
        door: 'ui',
        remote: REMOTE_B,
        name: 'apps.grants',
        params: { bundle: BUNDLE },
      })
    ).value as { codeHash: string }
    await dispatch({
      door: 'ui',
      remote: REMOTE_B,
      name: 'apps.grant',
      params: { bundle: BUNDLE, codeHash: grantB.codeHash, affordances: ['mail'] },
    })
    await call(REMOTE_B, leaseB, 'B')
    expect(
      await import('node:fs/promises').then(({ readFile }) =>
        readFile(join(rootB, 'writes.txt'), 'utf8'),
      ),
    ).toBe('B\n')

    active = vault(REMOTE_A, rootA)
    pluginHost.setDisplayed(REMOTE_A)
    const restartLease = await frameLease(REMOTE_A)
    await pluginHost.stop(REMOTE_A)
    await pluginHost.reconcile(active, 'open')
    await expect(call(REMOTE_A, restartLease, 'restarted')).rejects.toThrow()
    await pluginHost.stopAll()
  })
})
