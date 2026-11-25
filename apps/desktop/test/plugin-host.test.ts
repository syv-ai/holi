/**
 * The plugin host with test-only plugins: enablement gates dispatch and
 * seeding, and what is started follows the open vault's settings.
 */
import { request } from 'node:http'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import {
  createCapabilityRegistry,
  type CapabilityRegistry,
} from '../src/main/capabilities/registry'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { noCoreServices } from '../src/main/capabilities/services'
import { cap, noParams, type MainPlugin, type PluginCtx } from '../src/main/plugin-api'
import type { PluginEvent } from '../src/main/plugin-host/events'
import { schemeEntries, serveScheme } from '../src/main/plugin-host/schemes'
import { createPluginHost, type OpenVault } from '../src/main/plugin-host/host'
import { install } from '../src/main/plugin-host/installed'
import { coreSeed } from '../src/main/vault/seed/core'
import { readSeedState } from '../src/main/vault/seed/state'
import { readVaultSettings, writeVaultSettings } from '../src/main/vault/settings'
import { createPtySessions } from '../src/plugins/agent/main/host/pty-sessions'
import { createAgentTerminals } from '../src/plugins/agent/main/host/terminals'
import {
  createManagedTurnBrackets,
  createTurnCoordinator,
} from '../src/plugins/agent/main/host/turn-coordinator'
import { openTurnLog } from '../src/plugins/agent/main/host/turn-log'
import type { AgentProvider } from '../src/plugins/agent/main/provider'

const SKILL = '.claude/skills/fake/SKILL.md'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tempDir(prefix = 'holi-plugin-host-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** An open vault the test drives: what `host.open` would have made active. */
function openVault(
  remote: string,
  root: string,
  log: string[] = [],
  drainSync: () => Promise<void> = async () => {},
): OpenVault {
  return {
    remote,
    root,
    pause: (reason) => void log.push(`pause ${reason}`),
    resume: () => void log.push('resume'),
    drainSync,
    commitNow: async () => null,
    repo: { head: async () => 'sha' },
  }
}

function rig(
  opts: {
    default?: boolean
    roots?: Record<string, string>
    live?: string
    plugins?: MainPlugin[]
    registry?: CapabilityRegistry
    remote?: string
    bridge?: BridgeServer
    appDoor?: boolean
    call?: Parameters<typeof createPluginHost>[0]['call']
    rootFor?: (remote: string) => Promise<string | null>
    readSettings?: Parameters<typeof createPluginHost>[0]['readSettings']
    window?: () => import('electron').BrowserWindow | null
    frameOrigin?: (origin: string) => () => void
    navigate?: (plugin: string, remote: string, name: string, payload: unknown) => void
    notify?: (notice: import('../src/main/plugin-api').Notice) => boolean
  } = {},
) {
  const calls = { started: 0, stopped: 0 }
  const sent: { channel: string; event: PluginEvent }[] = []
  const listeners = new Map<string, Set<(message: unknown) => void>>()
  let context: PluginCtx | null = null
  let appDoor: ReturnType<PluginCtx['openAppDoor']> | null = null
  let open: OpenVault | null = null
  const activity: Parameters<NonNullable<Parameters<typeof createPluginHost>[0]['activity']>>[0][] =
    []
  const fake: MainPlugin = {
    info: { id: 'fake', label: 'Fake', default: opts.default ?? true },
    seed: { id: 'fake', once: {}, shipped: { [SKILL]: '# fake\n' } },
    activate(ctx) {
      context = ctx
      calls.started += 1
      ctx.register(['fake'], {
        'fake.ping': cap({
          doors: ['ui'],
          params: noParams,
          run: async () => `pong:${ctx.remote}`,
        }),
      })
      if (opts.bridge !== undefined)
        ctx.route('/same', { body: 'discard', handle: (remote) => ({ status: 200, body: remote }) })
      if (opts.appDoor) appDoor = ctx.openAppDoor({ admit: async () => {} })
      return () => {
        appDoor?.close()
        calls.stopped += 1
      }
    },
  }
  const plugins = opts.plugins ?? [fake]
  const registry = opts.registry ?? createCapabilityRegistry()
  const host = createPluginHost({
    plugins,
    registry,
    userData: '/nowhere',
    coreSeeds: [coreSeed(plugins.map((p) => p.info))],
    active: () => open,
    readSettings: opts.readSettings,
    rootFor: opts.rootFor ?? (async (remote) => opts.roots?.[remote] ?? null),
    events: {
      send: (channel, event) => void sent.push({ channel, event }),
      listen: (channel, handler) => {
        const handlers = listeners.get(channel) ?? new Set()
        handlers.add(handler)
        listeners.set(channel, handlers)
        return () => {
          handlers.delete(handler)
          if (handlers.size === 0) listeners.delete(channel)
        }
      },
      liveRemote: () => opts.live ?? null,
    },
    openAppDoor: (opener, remote) => capabilities.openAppDoor(opener, remote),
    route: (path, route, remote) => opts.bridge?.route(path, route, remote) ?? (() => {}),
    binDir: () => '/holi/bin',
    githubToken: () => null,
    frameOrigin: opts.frameOrigin ?? (() => () => {}),
    notify: opts.notify ?? (() => false),
    navigate: opts.navigate,
    focused: () => false,
    window: opts.window,
    activity: (entry) => activity.push(entry),
    call:
      opts.call ??
      (async (remote, name, params, beforeInvoke, finalization) =>
        (
          await capabilities.dispatch(
            {
              door: 'ui',
              remote,
              name,
              params,
              beforeInvoke,
            },
            finalization,
          )
        ).value),
  })
  let root = ''
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) =>
      opts.roots?.[remote] ?? (remote === (opts.remote ?? 'o/r') ? root : null),
    get: (_remote) => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at, allowDrain) =>
      (await host.serving(at, allowDrain)).has(plugin),
    claims: (at) => host.scanClaimsFor(at),
  })
  const ping = (at: string) => {
    root = at
    return capabilities.dispatch({
      door: 'ui',
      remote: opts.remote ?? 'o/r',
      name: 'fake.ping',
      params: {},
    })
  }
  /** What the renderer sends the plugin's main side. */
  const fromRenderer = (message: unknown) => {
    for (const handler of listeners.get('plugin:fake') ?? []) handler(message)
  }
  /** Make `vault` the open one and reconcile, as the router does after `host.open`. */
  const enter = async (vault: OpenVault | null) => {
    root = vault?.root ?? ''
    const previous = open
    if (previous !== null && previous.remote !== vault?.remote) await host.stop(previous.remote)
    open = vault
    host.setDisplayed(vault?.remote ?? null)
    if (vault === null) await host.stopAll()
    else await host.reconcile(vault, 'open')
  }
  const reconcile = async (why: 'settings' | 'snapshot') => {
    if (open === null) throw new Error('no vault is open')
    await host.reconcile(open, why)
  }
  return {
    host,
    registry,
    capabilities,
    calls,
    ping,
    sent,
    fromRenderer,
    enter,
    reconcile,
    ctx: () => context!,
    activity,
    appDoor: () => appDoor!,
  }
}

const turn = (root: string, on: boolean) =>
  writeVaultSettings(root, { committed: { plugins: { fake: on } } })

describe('app frame activation leases', () => {
  it('reports startup failure after a plugin invalidates its own activation', async () => {
    const root = await tempDir()
    let attempts = 0
    const plugin: MainPlugin = {
      info: { id: 'self-invalidating', label: 'Self invalidating', default: true },
      activate(ctx) {
        attempts++
        ctx.invalidateActivation()
        throw new Error('native activation failed')
      },
    }
    const h = rig({ plugins: [plugin] })
    await h.enter(openVault('o/r', root))
    expect(h.host.failures('o/r')).toEqual({ 'self-invalidating': 'native activation failed' })
    await h.reconcile('snapshot')
    expect(attempts).toBe(1)
    expect(h.host.failures('o/r')).toEqual({ 'self-invalidating': 'native activation failed' })
    await h.host.stop('o/r')
  })

  it('keeps wanted startup alive across unchanged snapshots while it awaits external work', async () => {
    const root = await tempDir()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const starting = new Promise<void>((resolve) => (entered = resolve))
    let registrations = 0
    const joining: MainPlugin = {
      info: { id: 'joining', label: 'Joining', default: true },
      async activate(ctx) {
        entered()
        await gate
        ctx.register(['joining'], {
          'joining.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'pong' }),
        })
        registrations++
        return () => {}
      },
    }
    const h = rig({ plugins: [joining] })
    const opening = h.enter(openVault('o/r', root))
    await starting
    const scan1 = h.reconcile('snapshot')
    const scan2 = h.reconcile('snapshot')
    release()
    await Promise.all([opening, scan1, scan2])
    expect(registrations).toBe(1)
    expect(h.registry.has('joining.ping', 'o/r')).toBe(true)
    await h.host.stop('o/r')
  })

  it('binds issued frame authority to its activation and presentation window', async () => {
    const root = await tempDir()
    const win = { isDestroyed: () => false } as unknown as import('electron').BrowserWindow
    const h = rig({ window: () => win })
    await h.enter(openVault('team/a', root))
    const lease = h.ctx().issueAppFrameLease('Tool.app')
    expect(lease.valid(win)).toBe(true)
    expect(lease.remote).toBe('team/a')
    expect(lease.root).toBe(root)

    h.host.setDisplayed('team/b')
    h.host.setDisplayed('team/a')
    expect(lease.valid(win)).toBe(false)
    await h.host.stop('team/a')
  })
})

/** A plugin that logs its start and stop. */
function logged(
  log: string[],
  id: string,
  info: Partial<MainPlugin['info']> = {},
  activate?: MainPlugin['activate'],
): MainPlugin {
  return {
    info: { id, label: id, default: true, ...info },
    activate:
      activate ??
      (() => {
        log.push(`start ${id}`)
        return () => void log.push(`stop ${id}`)
      }),
  }
}

describe('the plugin host', () => {
  it('routes plugin navigation requests through the host seam', async () => {
    const navigations: unknown[][] = []
    const r = rig({ navigate: (...args) => void navigations.push(args) })
    const root = await tempDir()
    await r.enter(openVault('o/r', root))

    r.ctx().navigate('o/target', 'inbox-open', { session: 'p0123456789ab' })

    expect(navigations).toEqual([['fake', 'o/target', 'inbox-open', { session: 'p0123456789ab' }]])
  })

  it('keeps an admitted notification target after its originating plugin stops', async () => {
    const navigations: unknown[][] = []
    let notice: import('../src/main/plugin-api').Notice | null = null
    const r = rig({
      navigate: (...args) => void navigations.push(args),
      notify: (value) => {
        notice = value
        return true
      },
    })
    const root = await tempDir()
    await r.enter(openVault('o/r', root))

    r.ctx().notify({
      title: 'Needs you',
      body: 'A decision is waiting.',
      navigate: { name: 'inbox-open', payload: { session: 'p0123456789ab' } },
      onClick: () => navigations.push(['legacy callback']),
    })
    await r.enter(null)
    notice!.onClick?.()

    expect(navigations).toEqual([
      ['fake', 'o/r', 'inbox-open', { session: 'p0123456789ab' }],
      ['legacy callback'],
    ])
  })

  it('tags plugin log lines and activation failures with actual ids, not labels', async () => {
    const plugins: MainPlugin[] = [
      {
        info: { id: 'google', label: 'Google', default: true },
        activate() {
          throw new Error('activation failed')
        },
      },
      {
        info: { id: 'search-google', label: 'Google adjacent', default: true },
        activate(ctx) {
          ctx.log('warn', 'runtime line')
          return () => {}
        },
      },
    ]
    const { host, enter, activity } = rig({ plugins })
    await enter(openVault('o/r', await tempDir()))
    expect(activity).toEqual([
      expect.objectContaining({ plugin: 'google', remote: 'o/r', message: 'Google did not start' }),
      expect.objectContaining({
        plugin: 'search-google',
        remote: 'o/r',
        message: 'Google adjacent: runtime line',
      }),
    ])
    expect(activity.filter((entry) => entry.plugin === 'google')).toHaveLength(1)
    expect(activity.filter((entry) => entry.plugin === 'search-google')).toHaveLength(1)
    await host.stop('o/r')
  })
  it('starts an enabled plugin once, however often the vault reconciles', async () => {
    const { host, calls, registry, enter, reconcile } = rig()
    const root = await tempDir()
    await enter(openVault('o/r', root))
    await reconcile('snapshot')
    await reconcile('settings')
    expect(calls.started).toBe(1)
    expect(registry.pluginOf('fake.ping', 'o/r')).toBe('fake')

    await host.stop('o/r')
    expect(calls.stopped).toBe(1)
    expect(registry.has('fake.ping', 'o/r')).toBe(false)
  })

  it('lets a fresh dependant finalizer use a provider capability until provider teardown', async () => {
    let providerCtx: PluginCtx | null = null
    let lateProviderRead: Promise<string> | null = null
    const commits: string[] = []
    const provider: MainPlugin = {
      info: { id: 'provider', label: 'Provider', default: true },
      activate(ctx) {
        providerCtx = ctx
        ctx.register(['probe'], {
          'probe.final': cap({
            doors: ['ui'],
            params: noParams,
            run: async () => {
              const head = await ctx.head()
              await ctx.commitNow()
              const nested = await ctx.call('probe.nested', {})
              lateProviderRead = new Promise((resolve) => {
                setImmediate(() => void ctx.head().then(resolve, () => resolve('rejected')))
              })
              return { head, nested }
            },
          }),
          'probe.nested': cap({
            doors: ['ui'],
            params: noParams,
            run: async () => ctx.head(),
          }),
        })
        return () => {}
      },
    }
    const dependant: MainPlugin = {
      info: { id: 'dependant', label: 'Dependant', default: true, requires: ['provider'] },
      activate(ctx) {
        return async () => {
          const result = await ctx.call('probe.final', {})
          expect(result).toEqual({ head: 'sha', nested: 'sha' })
          // Keep the owner draining while detached work tries the provider:
          // the awaited call ended, even though its disposer has not.
          await lateProviderRead
        }
      },
    }
    const plugins = [provider, dependant]
    const { host, enter, registry } = rig({ plugins })
    const root = await tempDir()
    const vault = openVault('o/r', root)
    vault.commitNow = async () => void commits.push('commit')
    await enter(vault)
    expect(registry.pluginOf('probe.final', 'o/r')).toBe('provider')

    await host.stop('o/r')

    expect(commits).toEqual(['commit'])
    expect(registry.has('probe.final', 'o/r')).toBe(false)
    expect(await lateProviderRead).toBe('rejected')
    await expect(providerCtx!.head()).rejects.toThrow('plugin context is no longer active')
    await expect(providerCtx!.call('probe.final', {})).rejects.toThrow(
      'plugin context is no longer active',
    )
  })

  it('preserves provider finalization across overlapping stop requests', async () => {
    let releaseProvider: () => void = () => {}
    let providerEntered: () => void = () => {}
    const gated = new Promise<void>((resolve) => (releaseProvider = resolve))
    const entered = new Promise<void>((resolve) => (providerEntered = resolve))
    let providerStops = 0
    let dependantStops = 0
    const commits: string[] = []
    const provider: MainPlugin = {
      info: { id: 'provider', label: 'Provider', default: true },
      activate(ctx) {
        ctx.register(['probe'], {
          'probe.final': cap({
            doors: ['ui'],
            params: noParams,
            run: async () => {
              await ctx.head()
              providerEntered()
              await gated
              await ctx.commitNow()
              return 'finalized'
            },
          }),
        })
        return () => {
          providerStops += 1
        }
      },
    }
    const dependant: MainPlugin = {
      info: { id: 'dependant', label: 'Dependant', default: true, requires: ['provider'] },
      activate(ctx) {
        return async () => {
          expect(await ctx.call('probe.final', {})).toBe('finalized')
          dependantStops += 1
        }
      },
    }
    const { host, enter } = rig({ plugins: [provider, dependant] })
    const root = await tempDir()
    const vault = openVault('o/r', root)
    vault.commitNow = async () => void commits.push('commit')
    await enter(vault)

    const firstStop = host.stop('o/r')
    await entered
    const overlappingStop = host.stop('o/r')
    releaseProvider()
    await Promise.all([firstStop, overlappingStop])

    expect(commits).toEqual(['commit'])
    expect(dependantStops).toBe(1)
    expect(providerStops).toBe(1)
  })

  it('allows a dependent disposer to call its provider while settings disable both', async () => {
    const order: string[] = []
    let providerCtx: PluginCtx | null = null
    const provider: MainPlugin = {
      info: { id: 'provider', label: 'Provider', default: true },
      activate(ctx) {
        providerCtx = ctx
        ctx.register(['provider'], {
          'provider.final': cap({
            doors: ['ui'],
            params: noParams,
            run: async () => ({
              head: await ctx.head(),
              nested: await ctx.call('provider.nested', {}),
            }),
          }),
          'provider.nested': cap({
            doors: ['ui'],
            params: noParams,
            run: async () => ctx.head(),
          }),
        })
        return () => void order.push('provider')
      },
    }
    const dependent: MainPlugin = {
      info: { id: 'dependent', label: 'Dependent', default: true, requires: ['provider'] },
      activate(ctx) {
        return async () => {
          order.push('dependent dispose')
          expect(await ctx.call('provider.final', {})).toEqual({ head: 'sha', nested: 'sha' })
          order.push('dependent')
        }
      },
    }
    const { host, enter, reconcile, registry } = rig({ plugins: [provider, dependent] })
    const root = await tempDir()
    await enter(openVault('o/r', root))
    expect(registry.has('provider.final', 'o/r')).toBe(true)

    await writeVaultSettings(root, {
      committed: { plugins: { provider: false, dependent: false } },
    })
    await reconcile('settings')

    expect(order).toEqual(['dependent dispose', 'dependent', 'provider'])
    expect(registry.has('provider.final', 'o/r')).toBe(false)
    await expect(providerCtx!.head()).rejects.toThrow('plugin context is no longer active')
    await expect(providerCtx!.call('provider.final', {})).rejects.toThrow(
      'plugin context is no longer active',
    )
    await host.stop('o/r')
  })

  it('does not start a plugin the vault has off', async () => {
    const { calls, enter, reconcile } = rig({ default: false })
    await enter(openVault('o/r', await tempDir()))
    expect(calls.started).toBe(0)
  })

  it("refuses a plugin's capability in a vault that has it off", async () => {
    const { ping, enter, reconcile } = rig()
    const on = await tempDir()
    const off = await tempDir()
    await turn(off, false)
    await enter(openVault('o/r', on))

    expect((await ping(on)).value).toBe('pong:o/r')
    await expect(ping(off)).rejects.toThrow('no such method: fake.ping')
  })
})

describe('vault-scoped plugin host adapters', () => {
  it('binds each host context to its remote and stopping A leaves B registered', async () => {
    const bridge = createBridgeServer({ log: () => {} })
    await bridge.start()
    const registry = createCapabilityRegistry()
    const a = rig({ registry, remote: 'A', roots: { A: '/A' }, bridge, appDoor: true })
    const b = rig({ registry, remote: 'B', roots: { B: '/B' }, bridge, appDoor: true })
    try {
      await a.enter(openVault('A', '/A'))
      await b.enter(openVault('B', '/B'))
      registry.register(['core'], {
        'core.remote': cap({ doors: ['app'], params: noParams, run: async (ctx) => ctx.remote }),
      })
      await expect(a.appDoor().call('B', 'T.app', 'core.remote', {})).rejects.toThrow(
        /belongs to A/,
      )
      expect((await a.appDoor().call('A', 'T.app', 'core.remote', {})).value).toBe('A')
      expect((await b.appDoor().call('B', 'T.app', 'core.remote', {})).value).toBe('B')
      expect((await a.ping('/A')).value).toBe('pong:A')
      expect((await b.ping('/B')).value).toBe('pong:B')
      const tokenA = bridge.tokenForVault('A')
      const tokenB = bridge.tokenForVault('B')
      const post = (token: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request(
            { host: '127.0.0.1', port: bridge.port()!, path: `/same?t=${token}`, method: 'POST' },
            (res) => {
              let body = ''
              res.on('data', (chunk) => {
                body += chunk
              })
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
            },
          )
          req.on('error', reject)
          req.end()
        })
      expect(await post(tokenA)).toEqual({ status: 200, body: 'A' })
      expect(await post(tokenB)).toEqual({ status: 200, body: 'B' })
      await a.host.stop('A')
      await expect(a.appDoor().call('A', 'T.app', 'core.remote', {})).rejects.toThrow(/closed/)
      await expect(a.ping('/A')).rejects.toThrow(/no such method/)
      expect((await b.ping('/B')).value).toBe('pong:B')
      expect((await post(tokenA)).status).toBe(404)
      expect(await post(tokenB)).toEqual({ status: 200, body: 'B' })
    } finally {
      await a.host.stop('A')
      await b.host.stop('B')
      await bridge.stop()
    }
  })
})

describe('the lifecycle', () => {
  it('keeps failures and dependent teardown scoped when one host runs two remotes', async () => {
    const starts: string[] = []
    const stops: string[] = []
    const events: string[] = []
    const contexts = new Map<string, PluginCtx>()
    const provider: MainPlugin = {
      info: { id: 'base', label: 'Base', default: true },
      activate(ctx) {
        starts.push(`base:${ctx.remote}`)
        contexts.set(ctx.remote, ctx)
        ctx.register(['base'], {
          'base.ping': cap({ doors: ['ui'], params: noParams, run: async () => ctx.remote }),
        })
        ctx.events.on((event) => events.push(`${ctx.remote}:${event.type}`))
        if (ctx.remote === 'A' && starts.filter((entry) => entry === 'base:A').length === 1)
          throw new Error('A unavailable')
        return () => stops.push(`base:${ctx.remote}`)
      },
    }
    const dependent: MainPlugin = {
      info: { id: 'face', label: 'Face', default: true, requires: ['base'] },
      activate(ctx) {
        starts.push(`face:${ctx.remote}`)
        return () => stops.push(`face:${ctx.remote}`)
      },
    }
    const aRoot = await tempDir()
    const bRoot = await tempDir()
    const { host, registry } = rig({
      plugins: [provider, dependent],
      roots: { A: aRoot, B: bRoot },
    })
    const a = openVault('A', aRoot)
    const b = openVault('B', bRoot)
    await host.reconcile(a, 'open')
    expect(host.failures('A')).toMatchObject({ base: 'A unavailable' })
    await host.reconcile(b, 'open')
    expect([...(await host.serving(bRoot))]).toEqual(expect.arrayContaining(['base', 'face']))
    await writeVaultSettings(aRoot, { committed: { plugins: { base: true } } })
    await host.reconcile(a, 'settings')
    expect(host.failures('A')).toEqual({})
    expect([...(await host.serving(aRoot))]).toEqual(expect.arrayContaining(['base', 'face']))
    await writeVaultSettings(aRoot, { committed: { plugins: { base: false } } })
    await host.reconcile(a, 'settings')
    expect(stops).toEqual(['face:A', 'base:A'])
    expect([...(await host.serving(bRoot))]).toEqual(expect.arrayContaining(['base', 'face']))
    expect(registry.has('base.ping', 'A')).toBe(false)
    expect(registry.has('base.ping', 'B')).toBe(true)
    contexts.get('B')!.events.emit({
      type: 'still-running',
      source: 'file',
      kind: 'changed',
      id: 'B',
      version: '1',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(['B:still-running'])
    await host.stopAll()
  })

  it('does not let a stopped vault hold resume its replacement or another remote', async () => {
    const contexts: PluginCtx[] = []
    const disposals: string[] = []
    let releaseDispose: () => void = () => {}
    let enteredDispose: () => void = () => {}
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve))
    const disposing = new Promise<void>((resolve) => (enteredDispose = resolve))
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.push(ctx)
        return async () => {
          disposals.push(ctx.remote)
          await ctx.commitNow()
          await ctx.head()
          if (ctx.remote === 'A' && contexts.length === 2) {
            enteredDispose()
            await disposeGate
          }
        }
      },
    }
    const { host } = rig({ plugins: [plugin] })
    const oldCalls: string[] = []
    const newCalls: string[] = []
    const otherCalls: string[] = []
    const oldVault = openVault('A', '/old', oldCalls)
    const newVault = openVault('A', '/new', newCalls)
    const otherVault = openVault('B', '/B', otherCalls)
    oldVault.commitNow = async () => {
      oldCalls.push('commit old')
      return null
    }
    newVault.commitNow = async () => {
      newCalls.push('commit new')
      return null
    }
    await host.reconcile(oldVault, 'open')
    await host.reconcile(otherVault, 'open')
    const oldRelease = contexts[0]!.pauseSync('old')
    const otherRelease = contexts[1]!.pauseSync('other')
    const stopping = host.stop('A')
    await disposing
    const reopening = host.reconcile(newVault, 'open')
    releaseDispose()
    await Promise.all([stopping, reopening])
    expect(contexts[2]!.active()).toBe(newVault)
    oldRelease()
    expect(oldCalls).toContain('resume')
    expect(oldCalls).toContain('commit old')
    expect(newCalls).not.toContain('resume')
    expect(otherCalls).not.toContain('resume')
    otherRelease()
    expect(disposals.filter((remote) => remote === 'A')).toHaveLength(1)
    expect(await contexts[2]!.head()).toBe('sha')
    await host.stopAll()
    expect(newCalls).toContain('commit new')
  })

  it('lets B start while A activation is pending and disposes a cancelled start once', async () => {
    const log: string[] = []
    let releaseA: () => void = () => {}
    let enteredA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const startedA = new Promise<void>((resolve) => {
      enteredA = resolve
    })
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      async activate(ctx) {
        if (ctx.remote === 'A') {
          enteredA()
          await gateA
        }
        return () => {
          log.push(`stop ${ctx.remote}`)
        }
      },
    }
    const { host } = rig({ plugins: [plugin], roots: { A: '/A', B: '/B' } })
    const a = openVault('A', '/A')
    const b = openVault('B', '/B')
    const pendingA = host.reconcile(a, 'open')
    await startedA
    await host.reconcile(b, 'open')
    expect(log).toEqual([])
    const stoppingA = host.stop('A')
    releaseA()
    await pendingA
    await stoppingA
    expect(log).toEqual(['stop A'])
    await host.stop('B')
    expect(log).toEqual(['stop A', 'stop B'])
  })

  it('does not activate a reconcile queued before stop, then reopens exactly once', async () => {
    let starts = 0
    const plugin = logged([], 'fake', {}, () => {
      starts += 1
      return () => {}
    })
    const { host } = rig({ plugins: [plugin] })
    const vault = openVault('A', '/A')
    const opening = host.reconcile(vault, 'open')
    const stopping = host.stop('A')
    await Promise.all([opening, stopping])
    expect(starts).toBe(0)
    await host.reconcile(vault, 'open')
    expect(starts).toBe(1)
    await host.stop('A')
  })

  it('invalidates presentation leases across A to B to A for queued plugin events', async () => {
    let ctx: PluginCtx | undefined
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(context) {
        ctx = context
        return () => {}
      },
    }
    const aRoot = await tempDir()
    const bRoot = await tempDir()
    const { host, sent } = rig({ plugins: [plugin], roots: { A: aRoot, B: bRoot } })
    await host.reconcile(openVault('A', aRoot), 'open')
    host.setDisplayed('A')
    const presentation = ctx!.presentationLease()
    ctx!.emit('A', 'key', { key: 'w' }, presentation)
    host.setDisplayed('B')
    host.setDisplayed('A')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
    await host.stopAll()
  })

  it('rejects queued inbound placement after returning to the same displayed vault', async () => {
    let gate = false
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const waiting = new Promise<void>((resolve) => (entered = resolve))
    const handled: unknown[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        ctx.on(
          'place',
          (_remote, payload) => handled.push(payload),
          () => ctx.presentationLease(),
        )
        return () => {}
      },
    }
    const aRoot = await tempDir()
    const { host, enter, fromRenderer } = rig({
      plugins: [plugin],
      roots: { A: aRoot },
      live: 'A',
      rootFor: async (remote) => {
        if (gate && remote === 'A') {
          entered()
          await blocked
        }
        return remote === 'A' ? aRoot : null
      },
    })
    await enter(openVault('A', aRoot))
    gate = true
    fromRenderer({ remote: 'A', name: 'place', payload: { id: 'same-page-id', rect: null } })
    await waiting
    host.setDisplayed('B')
    host.setDisplayed('A')
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(handled).toEqual([])
    await host.stopAll()
  })

  it('releases a failed activation frame-origin lease before retry', async () => {
    const { createFrameOrigins } = await import('../src/main/frame-origins')
    const frameOrigins = createFrameOrigins()
    let fail = true
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        ctx.frameOrigin('http://127.0.0.1:3040')
        if (fail) throw new Error('activation failed')
        return () => {}
      },
    }
    const { host, enter, reconcile } = rig({ plugins: [plugin], frameOrigin: frameOrigins.acquire })
    await enter(openVault('A', await tempDir()))
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(false)
    fail = false
    await reconcile('settings')
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(true)
    await host.stop('A')
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(false)
  })

  it('leases duplicate frame origins across retained vault activations', async () => {
    const { createFrameOrigins } = await import('../src/main/frame-origins')
    const frameOrigins = createFrameOrigins()
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        ctx.frameOrigin('http://127.0.0.1:3040')
        return () => {}
      },
    }
    const { host, enter } = rig({ plugins: [plugin], frameOrigin: frameOrigins.acquire })
    await enter(openVault('A', await tempDir()))
    await host.reconcile(openVault('B', await tempDir()), 'open')
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(true)
    await host.stop('A')
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(true)
    await host.stop('B')
    expect(frameOrigins.origins.has('http://127.0.0.1:3040')).toBe(false)
  })

  it('only exposes the native window to a live activation for the displayed vault', async () => {
    const contexts: PluginCtx[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.push(ctx)
        return () => {}
      },
    }
    const win = {} as import('electron').BrowserWindow
    const { host, enter } = rig({ plugins: [plugin], window: () => win })
    await enter(openVault('A', await tempDir()))
    const a = contexts[0]!
    expect(a.window()).toBe(win)
    host.setDisplayed('B')
    expect(a.window()).toBeNull()
    const bRoot = await tempDir()
    // Keep both plugin contexts alive without changing selected-vault lifetime.
    await host.reconcile(openVault('B', bRoot), 'open')
    const b = contexts[1]!
    expect(b.window()).toBe(win)
    host.setDisplayed('A')
    expect(a.window()).toBe(win)
    await host.stopAll()
    expect(a.window()).toBeNull()
  })

  it.each([
    ['stop', 'B'],
    ['stop', null],
    ['stopAll', 'B'],
    ['stopAll', null],
  ] as const)(
    'keeps detachment live during %s to %s without restoring authority',
    async (method, target) => {
      let ctx: PluginCtx | undefined
      const displayed: (string | null)[] = []
      let gate: { wait: Promise<void>; entered(): void } | undefined
      const plugin: MainPlugin = {
        info: { id: 'fake', label: 'Fake', default: true },
        activate(context) {
          ctx = context
          context.onDisplayChange((remote) => displayed.push(remote))
          return () => {}
        },
      }
      const delayed: MainPlugin = {
        info: { id: 'delayed', label: 'Delayed', default: false },
        async activate() {
          const pending = gate
          if (pending) {
            pending.entered()
            await pending.wait
          }
          return () => {}
        },
      }
      const win = {} as import('electron').BrowserWindow
      const root = await tempDir()
      const { host } = rig({ plugins: [plugin, delayed], window: () => win })
      await writeVaultSettings(root, { committed: { plugins: { delayed: false } } })
      await host.reconcile(openVault('A', root), 'open')
      host.setDisplayed('A')
      const lease = ctx!.presentationLease()
      expect(ctx!.window()).toBe(win)
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => (entered = resolve))
      let release!: () => void
      gate = {
        wait: new Promise<void>((resolve) => (release = resolve)),
        entered,
      }
      await writeVaultSettings(root, { committed: { plugins: { delayed: true } } })
      const reconcile = host.reconcile(openVault('A', root), 'settings')
      await waiting
      const stopping = method === 'stop' ? host.stop('A') : host.stopAll()
      expect(lease()).toBe(false)
      expect(ctx!.window()).toBeNull()
      host.setDisplayed(target)
      expect(displayed).toEqual(['A', target])
      host.setDisplayed('A')
      expect(lease()).toBe(false)
      expect(ctx!.presentationLease()()).toBe(false)
      expect(ctx!.window()).toBeNull()
      release()
      gate = undefined
      await Promise.all([reconcile, stopping])
      host.setDisplayed(target)
      expect(displayed).toEqual(['A', target, 'A'])
    },
  )

  it('revokes an old context on reactivation and exposes display changes through ctx', async () => {
    const contexts: PluginCtx[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.push(ctx)
        return () => {}
      },
    }
    const root = await tempDir()
    const { host, enter, reconcile } = rig({ plugins: [plugin] })
    await enter(openVault('A', root))
    const old = contexts[0]!
    const displayed: (string | null)[] = []
    old.onDisplayChange((remote) => displayed.push(remote))
    host.setDisplayed('B')
    expect(old.displayed()).toBe('B')
    expect(displayed).toEqual(['B'])

    await turn(root, false)
    await reconcile('settings')
    await turn(root, true)
    await reconcile('settings')
    const current = contexts[1]!
    host.setDisplayed('C')
    expect(displayed).toEqual(['B'])
    expect(() => old.register(['fake'], {})).toThrow(/activation was cancelled/)
    expect(() => old.pauseSync('stale')).toThrow(/no longer active/)
    old.publish('stale', null)
    expect(current.displayed()).toBe('C')
    current.publish('live', null)
    await host.stop('A')
  })

  it('retires every callback and context capability from a failed activation', async () => {
    let old: PluginCtx | null = null
    let fail = true
    const log: string[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        if (fail) {
          old = ctx
          throw new Error('activation failed')
        }
        ctx.register(['fake'], {
          'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'fresh' }),
        })
        return () => {}
      },
    }
    const root = await tempDir()
    const { host, enter, reconcile, registry } = rig({ plugins: [plugin] })
    await enter(openVault('A', root))
    expect(host.failures('A')).toEqual({ fake: 'activation failed' })
    expect(() => old!.register(['fake'], {})).toThrow()
    expect(() => old!.pauseSync('stale')).toThrow()
    expect(() => old!.on('input', () => log.push('input'))).toThrow()
    expect(() => old!.onDisplayChange(() => log.push('display'))).toThrow()
    expect(() => old!.hear('provider', 'news', () => log.push('hear'))).toThrow()
    expect(() => old!.onReport(() => log.push('report'))).toThrow()
    expect(() => old!.onSnapshot(() => log.push('snapshot'))).toThrow()
    expect(() => old!.events.on(() => log.push('event'))).toThrow()
    old!.emit('A', 'stale', null)
    old!.publish('news', null)
    old!.events.emit({ type: 'stale', source: 'file', kind: 'changed', id: 'A', version: '1' })
    expect(log).toEqual([])
    expect(registry.has('fake.ping', 'A')).toBe(false)

    fail = false
    await reconcile('settings')
    expect(registry.has('fake.ping', 'A')).toBe(true)
    await host.stop('A')
  })

  it('stops inbound callbacks when settings disable a plugin during its disposer', async () => {
    let ctx: PluginCtx | null = null
    let providerCtx: PluginCtx | null = null
    let disposing: () => void = () => {}
    let finish: () => void = () => {}
    const enteredDispose = new Promise<void>((resolve) => (disposing = resolve))
    const disposeGate = new Promise<void>((resolve) => (finish = resolve))
    const received: string[] = []
    const provider: MainPlugin = {
      info: { id: 'base', label: 'Base', default: true },
      activate(context) {
        providerCtx = context
        return () => {}
      },
    }
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true, requires: ['base'] },
      activate(context) {
        ctx = context
        context.hear('base', 'news', () => received.push('hear'))
        context.onReport(() => received.push('report'))
        context.onMention(() => received.push('mention'))
        context.onSnapshot(() => received.push('snapshot'))
        context.on('input', () => received.push('input'))
        context.events.on(() => received.push('event'))
        return async () => {
          disposing()
          await disposeGate
        }
      },
    }
    const root = await tempDir()
    const { host, enter, reconcile, fromRenderer } = rig({
      plugins: [provider, plugin],
      live: 'A',
      roots: { A: root },
    })
    await enter(openVault('A', root))
    await turn(root, false)
    const stopping = reconcile('settings')
    await enteredDispose
    fromRenderer({ remote: 'A', name: 'input', payload: null })
    host.report('A', { focusedPath: 'a.md', selection: null, openPaths: [], recents: [] })
    host.mentioned('A', [{ notePath: 'a.md' } as never])
    host.snapshot('A', { root: 'A' } as never)
    ctx!.events.emit({
      type: 'during-drain',
      source: 'file',
      kind: 'changed',
      id: 'A',
      version: '1',
    })
    providerCtx!.publish('news', null)
    providerCtx!.events.emit({
      type: 'provider-during-drain',
      source: 'file',
      kind: 'changed',
      id: 'A',
      version: '1',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(received).toEqual([])
    finish()
    await stopping
    await host.stopAll()
  })

  it('delivers final output and vault events emitted by a synchronous disposer', async () => {
    const heard: string[] = []
    const provider: MainPlugin = {
      info: { id: 'base', label: 'Base', default: true },
      activate(ctx) {
        ctx.events.on((event) => heard.push(event.type))
        return () => {}
      },
    }
    const finalizer: MainPlugin = {
      info: { id: 'face', label: 'Face', default: true, requires: ['base'] },
      activate(context) {
        return () => {
          context.emit('A', 'final', 'done')
          context.events.emit({
            type: 'final-event',
            source: 'file',
            kind: 'changed',
            id: 'A',
            version: '1',
          })
        }
      },
    }
    const { host, sent, enter } = rig({ plugins: [provider, finalizer], roots: { A: '/A' } })
    await enter(openVault('A', '/A'))
    await host.stop('A')
    expect(sent.map((item) => item.event)).toEqual([
      { remote: 'A', name: 'final', payload: 'done' },
    ])
    expect(heard).toContain('final-event')
  })

  it('delivers synchronous disposer output when settings disable a plugin', async () => {
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        return () => ctx.emit('A', 'disabled-final', null)
      },
    }
    const root = await tempDir()
    const { sent, enter, reconcile } = rig({ plugins: [plugin], roots: { A: root } })
    await enter(openVault('A', root))
    await turn(root, false)
    await reconcile('settings')
    expect(sent.map((item) => item.event.name)).toEqual(['disabled-final'])
  })

  it('does not let a fresh final output wait behind a cancelled outbound gate', async () => {
    let ctx: PluginCtx | null = null
    let releaseOld: () => void = () => {}
    let gateEntered: () => void = () => {}
    const oldGate = new Promise<void>((resolve) => (releaseOld = resolve))
    const entered = new Promise<void>((resolve) => (gateEntered = resolve))
    let rootLookups = 0
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(context) {
        ctx = context
        return () => context.emit('A', 'final', null)
      },
    }
    const { host, enter, sent } = rig({
      plugins: [plugin],
      rootFor: async () => {
        rootLookups += 1
        if (rootLookups === 1) {
          gateEntered()
          await oldGate
        }
        return '/A'
      },
    })
    await enter(openVault('A', '/A'))
    ctx!.emit('A', 'old', null)
    await entered
    const stopping = host.stop('A')
    try {
      await stopping
      await host.reconcile(openVault('A', '/A'), 'open')
      expect(sent.map((item) => item.event.name)).toEqual(['final'])
    } finally {
      releaseOld()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent.map((item) => item.event.name)).toEqual(['final'])
  })

  it('drops host-routed output queued before stop after its async gate', async () => {
    let ctx: PluginCtx | null = null
    let release: () => void = () => {}
    let releaseDispose: () => void = () => {}
    let waiting: () => void = () => {}
    let disposing: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve))
    const entered = new Promise<void>((resolve) => (waiting = resolve))
    const disposeEntered = new Promise<void>((resolve) => (disposing = resolve))
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(context) {
        ctx = context
        return async () => {
          disposing()
          await disposeGate
        }
      },
    }
    const { host, sent, enter } = rig({
      plugins: [plugin],
      rootFor: async () => {
        waiting()
        await gate
        return '/A'
      },
    })
    await enter(openVault('A', '/A'))
    ctx!.emit('A', 'stale', null)
    await entered
    const stopping = host.stop('A')
    await disposeEntered
    release()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(sent).toEqual([])
    releaseDispose()
    await stopping
  })

  it('keeps disposal commit and head bound to its vault while another is displayed', async () => {
    let ctx: PluginCtx | null = null
    const calls: string[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(context) {
        ctx = context
        return async () => {
          await context.commitNow()
          await context.head()
          await context.call('target.read', {})
        }
      },
    }
    const vault = openVault('A', '/A', calls)
    vault.commitNow = async () => {
      calls.push('commit A')
      return null
    }
    vault.repo.head = async () => {
      calls.push('head A')
      return 'sha-A'
    }
    const { host, enter } = rig({
      plugins: [plugin],
      call: async (remote, _name, _params, beforeInvoke) => {
        await beforeInvoke?.({ remote, root: '/A' })
        calls.push(`cap ${remote}`)
        return null
      },
    })
    await enter(vault)
    host.setDisplayed('B')
    await host.stop('A')
    expect(calls).toEqual(['commit A', 'head A', 'cap A'])
    expect(ctx!.displayed()).toBe('B')
    await expect(ctx!.head()).rejects.toThrow(/no longer active/)
  })

  it('rejects a pre-stop queued capability before invocation during disposer drain', async () => {
    let ctx: PluginCtx | null = null
    let enterDispose: () => void = () => {}
    let releaseDispose: () => void = () => {}
    let releaseCall: () => void = () => {}
    const disposing = new Promise<void>((resolve) => (enterDispose = resolve))
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve))
    const callGate = new Promise<void>((resolve) => (releaseCall = resolve))
    let invocations = 0
    const plugin: MainPlugin = {
      info: { id: 'caller', label: 'Caller', default: true },
      activate(context) {
        ctx = context
        return async () => {
          enterDispose()
          await disposeGate
        }
      },
    }
    const { host, enter } = rig({
      plugins: [plugin],
      call: async (remote, _name, _params, beforeInvoke) => {
        await callGate
        await beforeInvoke?.({ remote, root: '/A' })
        invocations += 1
        return 'invoked'
      },
    })
    await enter(openVault('A', '/A'))
    const delayed = ctx!.call('target.read', {})
    const stopping = host.stop('A')
    await disposing
    releaseCall()
    await expect(delayed).rejects.toThrow(/context is no longer active/)
    expect(invocations).toBe(0)
    releaseDispose()
    await stopping
  })

  it('rechecks a delayed ctx capability call after its caller stops', async () => {
    let ctx: PluginCtx | null = null
    let continueCall: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      continueCall = resolve
    })
    const plugin: MainPlugin = {
      info: { id: 'caller', label: 'Caller', default: true },
      activate(context) {
        ctx = context
        return () => {}
      },
    }
    const { host, enter } = rig({
      plugins: [plugin],
      call: async (remote, _name, _params, beforeInvoke) => {
        await gate
        await beforeInvoke?.({ remote, root: '/A' })
        return 'invoked'
      },
    })
    const vault = openVault('A', '/A')
    await enter(vault)
    const delayed = ctx!.call('target.read', {})
    await host.stop('A')
    await host.reconcile(vault, 'open')
    continueCall()
    await expect(delayed).rejects.toThrow(/context is no longer active/)
    await host.stopAll()
  })

  it('keeps concurrent remote instances, holds and notifications isolated', async () => {
    const contexts = new Map<string, PluginCtx>()
    const seen = new Map<string, string[]>()
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.set(ctx.remote, ctx)
        const got: string[] = []
        seen.set(ctx.remote, got)
        ctx.onReport((report) => got.push(`report:${report.focusedPath}`))
        ctx.onMention((mention) => got.push(`mention:${mention.notePath}`))
        ctx.onSnapshot((snapshot) => got.push(`snapshot:${snapshot.root}`))
        ctx.events.on((event) => got.push(`event:${event.type}`))
        ctx.events.emit({
          type: 'happened',
          source: 'file',
          kind: 'changed',
          id: ctx.remote,
          version: '1',
        })
        return () => {}
      },
    }
    const { host, enter } = rig({ plugins: [plugin], roots: { A: '/A', B: '/B' } })
    const logA: string[] = []
    const logB: string[] = []
    const a = openVault('A', '/A', logA)
    const b = openVault('B', '/B', logB)
    await enter(a)
    host.setDisplayed('B')
    await host.reconcile(b, 'open')

    expect(contexts.get('A')?.active().remote).toBe('A')
    expect(contexts.get('B')?.active().remote).toBe('B')
    const releaseA = contexts.get('A')!.pauseSync('A hold')
    const releaseB = contexts.get('B')!.pauseSync('B hold')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(seen.get('A')).toEqual(['event:happened'])
    expect(seen.get('B')).toEqual(['event:happened'])

    host.report('A', { focusedPath: 'a.md', selection: null, openPaths: [], recents: [] })
    host.report('B', { focusedPath: 'b.md', selection: null, openPaths: [], recents: [] })
    host.mentioned('A', [{ notePath: 'a.md' } as never])
    host.mentioned('B', [{ notePath: 'b.md' } as never])
    host.snapshot('A', { root: 'A' } as never)
    host.snapshot('B', { root: 'B' } as never)
    expect(seen.get('A')).toContain('report:a.md')
    expect(seen.get('B')).toContain('report:b.md')
    expect(seen.get('A')).toContain('snapshot:A')
    expect(seen.get('B')).toContain('snapshot:B')
    expect(seen.get('A')).toContain('mention:a.md')
    expect(seen.get('B')).toContain('mention:b.md')

    releaseA()
    expect(logA).toContain('resume')
    expect(logB).not.toContain('resume')
    releaseB()
    expect(logB).toContain('resume')
    await host.stop('A')
    await expect(host.serving('/B')).resolves.toContain('fake')
    await host.stop('B')
  })
  it('stops a plugin turned off by hand, and starts it again, seeded, when turned back on', async () => {
    const { host, calls, registry, enter, reconcile } = rig()
    const root = await tempDir()
    await enter(openVault('o/r', root))

    await turn(root, false)
    await reconcile('snapshot')
    expect(calls).toEqual({ started: 1, stopped: 1 })
    expect(registry.has('fake.ping', 'o/r')).toBe(false)

    await turn(root, true)
    await reconcile('snapshot')
    expect(calls).toEqual({ started: 2, stopped: 1 })
    expect(registry.pluginOf('fake.ping', 'o/r')).toBe('fake')
  })

  it('keeps a plugin turned off served until its disposer is done', async () => {
    const root = await tempDir()
    let finish: () => void = () => {}
    let going: () => void = () => {}
    const left = new Promise<void>((resolve) => (going = resolve))
    const winding: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        ctx.register(['fake'], {
          'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'pong' }),
        })
        // A meeting's recording: the renderer is told, and its last calls
        // still land, before the disposer lets go.
        return async () => {
          ctx.emit(ctx.remote, 'stop-recording', null)
          going()
          await new Promise<void>((resolve) => (finish = resolve))
        }
      },
    }
    const { host, ping, sent, enter, reconcile } = rig({
      plugins: [winding],
      roots: { 'o/r': root },
    })
    await enter(openVault('o/r', root))

    await turn(root, false)
    const stopped = reconcile('settings')
    await left
    await vi.waitFor(() => expect(sent.map((s) => s.event.name)).toEqual(['stop-recording']))
    await expect(ping(root)).rejects.toThrow('no such method: fake.ping')

    finish()
    await stopped
    await expect(ping(root)).rejects.toThrow('no such method: fake.ping')
  })

  it('starts what a plugin requires first, and stops it last', async () => {
    const log: string[] = []
    const plugins = [
      logged(log, 'face', { requires: ['base'] }),
      logged(log, 'skin', { requires: ['face'] }),
      logged(log, 'base'),
    ]
    const { host, enter, reconcile } = rig({ plugins })
    const root = await tempDir()
    await enter(openVault('o/r', root))
    expect(log).toEqual(['start base', 'start face', 'start skin'])

    log.length = 0
    await writeVaultSettings(root, { committed: { plugins: { base: false } } })
    await reconcile('settings')
    expect(log).toEqual(['stop skin', 'stop face', 'stop base'])
  })

  it('keeps nothing across a switch: every plugin stops, and starts fresh in the next vault', async () => {
    const log: string[] = []
    const plugins = [logged(log, 'base')]
    const { enter } = rig({ plugins })
    await enter(openVault('o/a', await tempDir()))
    await enter(openVault('o/b', await tempDir()))
    expect(log).toEqual(['start base', 'stop base', 'start base'])
    await enter(null)
    expect(log.at(-1)).toBe('stop base')
  })

  it('says why a plugin did not start, and tries again on a write but not on a bare change', async () => {
    let fails = true
    const log: string[] = []
    const plugins = [
      logged(log, 'base', {}, () => {
        log.push('try base')
        if (fails) throw new Error('keychain locked')
        return () => {}
      }),
      logged(log, 'face', { requires: ['base'] }),
    ]
    const { host, enter, reconcile } = rig({ plugins })
    await enter(openVault('o/r', await tempDir()))
    expect(host.failures('o/r')).toEqual({ base: 'keychain locked', face: 'base did not start.' })

    await reconcile('snapshot')
    expect(log).toEqual(['try base'])

    fails = false
    await reconcile('settings')
    expect(log).toEqual(['try base', 'try base', 'start face'])
    expect(host.failures('o/r')).toEqual({})
  })

  it('carries what one main side publishes to those that require it, until they stop', async () => {
    const heard: unknown[] = []
    let base: PluginCtx | null = null
    const log: string[] = []
    const plugins = [
      logged(log, 'base', {}, (c) => {
        base = c
        return () => {}
      }),
      logged(log, 'face', { requires: ['base'] }, (c) => {
        c.hear('base', 'news', (p) => heard.push(p))
        return () => {}
      }),
      logged(log, 'stranger', {}, (c) => {
        // Not built on base: hearing it is refused, so the plugin does not start.
        c.hear('base', 'news', () => {})
        return () => {}
      }),
    ]
    const { host, enter, reconcile } = rig({ plugins })
    const root = await tempDir()
    await enter(openVault('o/r', root))
    base!.publish('news', 1)
    expect(heard).toEqual([1])
    expect(host.failures('o/r')['stranger']).toMatch(/does not require/)

    await writeVaultSettings(root, { committed: { plugins: { face: false } } })
    await reconcile('settings')
    base!.publish('news', 2)
    expect(heard).toEqual([1])
  })

  it('binds the context to the vault, and lets go of its holds when it stops', async () => {
    const root = await tempDir()
    const log: string[] = []
    let ctx: PluginCtx | null = null
    const plugins = [
      logged(log, 'base', {}, (c) => {
        ctx = c
        return () => void log.push('stop base')
      }),
    ]
    const { host, enter, reconcile } = rig({ plugins })
    await enter(openVault('o/r', root, log))
    expect([ctx!.remote, ctx!.root]).toEqual(['o/r', root])

    // Holds stack: the loop runs again only when the last is released.
    const first = ctx!.pauseSync('one')
    const second = ctx!.pauseSync('two')
    first()
    first()
    second()
    expect(log).toEqual(['pause one', 'pause two', 'pause two', 'resume'])

    ctx!.pauseSync('held')
    await host.stop('o/r')
    expect(log.slice(-3)).toEqual(['pause held', 'stop base', 'resume'])
  })

  it('drains running Git work before returning a sync hold, and releases on drain failure', async () => {
    const root = await tempDir()
    const log: string[] = []
    let ctx: PluginCtx | null = null
    const plugins = [logged(log, 'base', {}, (c) => ((ctx = c), () => {}))]
    let finish!: () => void
    const draining = new Promise<void>((resolve) => (finish = resolve))
    const { host, enter } = rig({ plugins })
    await enter(openVault('o/r', root, log, () => draining))

    let settled = false
    const holding = ctx!.pauseSyncAndDrain('PDF migration').then((release) => {
      settled = true
      return release
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(log).toContain('pause PDF migration')
    finish()
    const release = await holding
    release()
    expect(log.slice(-2)).toEqual(['pause PDF migration', 'resume'])

    await host.stop('o/r')
  })

  it('releases a pending drain when the plugin stops', async () => {
    const root = await tempDir()
    const log: string[] = []
    let ctx: PluginCtx | null = null
    const plugins = [logged(log, 'base', {}, (c) => ((ctx = c), () => {}))]
    let finish!: () => void
    const draining = new Promise<void>((resolve) => (finish = resolve))
    const { host, enter } = rig({ plugins })
    await enter(openVault('o/r', root, log, () => draining))
    const holding = ctx!.pauseSyncAndDrain('pending', { retainOnFailure: true })
    await Promise.resolve()
    await host.stop('o/r')
    finish()
    await expect(holding).rejects.toThrow(/cancelled/)
    expect(log.slice(-2)).toEqual(['pause pending', 'resume'])
  })

  it('releases a failed drain and does not hold another vault', async () => {
    const roots = { 'o/a': await tempDir(), 'o/b': await tempDir() }
    const log: string[] = []
    const contexts = new Map<string, PluginCtx>()
    const plugins = [logged(log, 'base', {}, (ctx) => (contexts.set(ctx.remote, ctx), () => {}))]
    const { host } = rig({ plugins, roots })
    await host.reconcile(
      openVault('o/a', roots['o/a']!, log, async () => {
        throw new Error('drain failed')
      }),
      'open',
    )
    await host.reconcile(openVault('o/b', roots['o/b']!, log), 'open')
    await expect(contexts.get('o/a')!.pauseSyncAndDrain('failed')).rejects.toThrow('drain failed')
    expect(log).toContain('pause failed')
    expect(log.slice(-1)).toEqual(['resume'])
    await host.stop('o/a')
    await host.stop('o/b')
  })

  it("tells a started plugin of its vault's snapshots, until it stops", async () => {
    const root = await tempDir()
    const heard: string[] = []
    const plugins = [
      logged([], 'base', {}, (c) => {
        c.onSnapshot((snapshot) => heard.push(snapshot.files.map((f) => f.path).join()))
        return () => {}
      }),
    ]
    const { host, enter, reconcile } = rig({ plugins })
    await enter(openVault('o/r', root))
    const snapshot = (path: string) =>
      ({ files: [{ path, updatedAt: '' }] }) as unknown as Parameters<typeof host.snapshot>[1]
    host.snapshot('o/r', snapshot('a.txt'))
    host.snapshot('o/other', snapshot('b.txt'))
    await host.stop('o/r')
    host.snapshot('o/r', snapshot('c.txt'))
    expect(heard).toEqual(['a.txt'])
  })
})

describe('plugin events', () => {
  it('reach the renderer only about a vault that runs the plugin, in order', async () => {
    const on = await tempDir()
    const off = await tempDir()
    await turn(off, false)
    const { ctx, sent, enter, reconcile } = rig({ roots: { 'o/on': on, 'o/off': off } })
    await enter(openVault('o/on', on))

    ctx().emit('o/on', 'tick', 1)
    ctx().emit('o/off', 'tick', 2)
    ctx().emit('o/on', 'tick', 3)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map((s) => s.event.payload)).toEqual([1, 3])
    expect(sent[0]).toEqual({
      channel: 'plugin:fake',
      event: { remote: 'o/on', name: 'tick', payload: 1 },
    })
    expect(() => ctx().emit('o/on', 'Not Kebab', null)).toThrow()
  })

  it('keeps renderer handlers for both running remote instances', async () => {
    const contexts = new Map<string, PluginCtx>()
    const heard = new Map<string, string[]>()
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.set(ctx.remote, ctx)
        heard.set(ctx.remote, [])
        ctx.on('input', (remote, payload) => heard.get(ctx.remote)!.push(`${remote}:${payload}`))
        return () => {}
      },
    }
    const { host, fromRenderer } = rig({
      plugins: [plugin],
      live: 'B',
      roots: { A: '/A', B: '/B' },
    })
    await host.reconcile(openVault('A', '/A'), 'open')
    await host.reconcile(openVault('B', '/B'), 'open')
    host.setDisplayed('B')
    fromRenderer({ remote: 'B', name: 'input', payload: 'current' })
    await vi.waitFor(() => expect(heard.get('B')).toEqual(['B:current']))
    expect(heard.get('A')).toEqual([])
    await host.stop('A')
    fromRenderer({ remote: 'B', name: 'input', payload: 'still-live' })
    await vi.waitFor(() => expect(heard.get('B')).toEqual(['B:current', 'B:still-live']))
    await host.stop('B')
    expect(contexts.size).toBe(2)
  })

  it("hear only the open vault's messages", async () => {
    const root = await tempDir()
    const { ctx, fromRenderer, enter, reconcile } = rig({
      roots: { 'o/live': root },
      live: 'o/live',
    })
    await enter(openVault('o/live', root))
    const heard: unknown[] = []
    ctx().on('key', (remote, payload) => heard.push([remote, payload]))

    fromRenderer({ remote: 'o/other', name: 'key', payload: 'x' })
    fromRenderer({ remote: 'o/live', name: 'other', payload: 'y' })
    fromRenderer({ remote: 'o/live', name: 'key', payload: 'a' })
    fromRenderer({ remote: 'o/live', name: 'key', payload: 'b' })
    await vi.waitFor(() => expect(heard).toHaveLength(2))
    expect(heard).toEqual([
      ['o/live', 'a'],
      ['o/live', 'b'],
    ])
  })
})

describe('plugin schemes', () => {
  it("answer 404 while the open vault has the scheme's plugin off", async () => {
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      schemes: [{ scheme: 'holi-fake', privileges: {}, handle: () => new Response('served') }],
    }
    const [entry] = schemeEntries([], [plugin])
    const root = await tempDir()
    let runs = true
    const serve = serveScheme(entry!, {
      active: () => ({ remote: 'o/r', root }),
      runs: async () => runs,
    })
    expect(await (await serve(new Request('holi-fake://x/'))).text()).toBe('served')
    runs = false
    expect((await serve(new Request('holi-fake://x/'))).status).toBe(404)
    expect(() => schemeEntries(plugin.schemes!, [plugin])).toThrow('served twice')
  })
})

describe('seeding by enablement', () => {
  it("writes an enabled plugin's shipped files when the vault is created", async () => {
    const { host } = rig()
    const root = await tempDir()
    await host.seed(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe('# fake\n')
    expect((await readSeedState(root)).plugins).toEqual(['fake'])
  })

  it('only records a baseline the first time a machine sees a clone', async () => {
    const { host } = rig()
    const root = await tempDir()
    await host.seed(root)
    await unlink(join(root, SKILL))
    // Another machine: the vault exists, this machine has no seed state.
    await rm(join(root, '.holi/state'), { recursive: true })

    await host.seed(root)
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()
    expect((await readSeedState(root)).plugins).toEqual(['fake'])
  })

  it('seeds a plugin turned on later, once', async () => {
    const { host } = rig()
    const root = await tempDir()
    await turn(root, false)
    await host.seed(root)
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()

    await turn(root, true)
    await host.seed(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe('# fake\n')

    // The team deleted it: it stays deleted, and off and on again changes nothing.
    await unlink(join(root, SKILL))
    await turn(root, false)
    await host.seed(root)
    await turn(root, true)
    await host.seed(root)
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()
  })
})

describe('an owned prefix', () => {
  it('is respected by the plugins this build ships', async () => {
    const { MAIN_PLUGINS } = await import('../src/plugins/main')
    expect(() => install(MAIN_PLUGINS)).not.toThrow()
  })

  it("holds another plugin's files under it until the owner is on, then seeds them once", async () => {
    const OWN = '.claude/settings.json'
    const owner: MainPlugin = {
      info: { id: 'owner', label: 'Owner', default: true },
      seed: { id: 'owner', owns: ['.claude/'], once: { [OWN]: '{}\n' }, shipped: {} },
    }
    const fake: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true, addsTo: ['owner'] },
      seed: { id: 'fake', once: {}, shipped: { [SKILL]: '# fake\n', 'fake.md': '# fake\n' } },
    }
    // Saying nothing of the owner, it may not seed there at all.
    expect(() => install([owner, { ...fake, info: { ...fake.info, addsTo: [] } }])).toThrow(
      'without adding to it',
    )
    const host = createPluginHost({
      plugins: [owner, fake],
      registry: createCapabilityRegistry(),
      userData: '/nowhere',
      coreSeeds: [coreSeed([owner.info, fake.info])],
      active: () => null,
      rootFor: async () => null,
      events: { send: () => {}, listen: () => () => {}, liveRemote: () => null },
      openAppDoor: () => {
        throw new Error('unused')
      },
      route: () => () => {},
      binDir: () => '/holi/bin',
      githubToken: () => null,
      frameOrigin: () => () => {},
      notify: () => false,
      focused: () => false,
    })
    const root = await tempDir()
    const set = (on: boolean) => writeVaultSettings(root, { committed: { plugins: { owner: on } } })

    await set(false)
    await host.seed(root)
    expect(await readFile(join(root, 'fake.md'), 'utf8')).toBe('# fake\n')
    await expect(readFile(join(root, OWN), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()

    await set(true)
    await host.seed(root)
    expect(await readFile(join(root, SKILL), 'utf8')).toBe('# fake\n')
    expect((await readSeedState(root)).plugins).toContain('fake@owner')

    // Deleted while the owner runs: it stays deleted.
    await unlink(join(root, SKILL))
    await host.seed(root)
    await expect(readFile(join(root, SKILL), 'utf8')).rejects.toThrow()
  })
})

describe('activation cancellation and teardown failures', () => {
  it.each(['success', 'proof failure'] as const)(
    'keeps plugin shutdown joined to the original PTY proof past 10 seconds: %s',
    async (mode) => {
      const root = await tempDir()
      const vault = openVault('A', root)
      const proof = repairGate()
      const cause = new Error('original PTY proof failure')
      const drain = vi.fn(async () => {
        await proof.promise
        if (mode === 'proof failure') throw cause
      })
      let exit!: (event: { exitCode: number }) => void
      const pty = {
        pid: 999_999,
        onData: () => {},
        onExit: (cb: typeof exit) => {
          exit = cb
        },
        write: () => {},
        resize: () => {},
        kill: vi.fn(),
      }
      const terminals = createAgentTerminals({
        emit: () => {},
        log: () => {},
        spawnPty: () => pty,
        superviseGroup: () => ({ drain }),
      })
      const provider: AgentProvider = {
        id: 'codex',
        label: 'Codex',
        notInstalled: 'not installed',
        installed: () => true,
        configure: async () => ({ dir: root }),
        terminal: () => ({ bin: 'fixture', args: [], env: {} }),
        capabilities: {},
      }
      const dispose = vi.fn()
      const sessions = createPtySessions({
        vault,
        terminals,
        providers: () => [provider],
        bracket: () => {},
        binDir: () => null,
        onChange: () => {},
      })
      const { host } = rig({
        plugins: [
          {
            info: { id: 'fake', label: 'Fake', default: true },
            activate: () => () => {
              dispose()
              return sessions.leave()
            },
          },
        ],
      })
      await host.reconcile(vault, 'open')
      const started = await sessions.start('codex', {})
      if (!started.ok) throw new Error(started.message)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const first = host.stop('A').catch((error: unknown) => error)
        const second = host.stop('A').catch((error: unknown) => error)
        const settled = vi.fn()
        void first.then(settled)
        await vi.advanceTimersByTimeAsync(12_000)
        expect(settled).not.toHaveBeenCalled()
        expect(drain).toHaveBeenCalledOnce()
        expect(sessions.has(started.sessionId)).toBe(true)
        proof.resolve()
        if (mode === 'success') {
          exit({ exitCode: 0 })
          await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
          expect(sessions.has(started.sessionId)).toBe(false)
        } else {
          // No public exit: known physical failure must win immediately.
          await vi.advanceTimersByTimeAsync(0)
          expect(settled).toHaveBeenCalledOnce()
          const failure = await first
          expect(failure).toMatchObject({ errors: [{ errors: [{ errors: [cause] }] }] })
          expect(await second).toBe(failure)
          await expect(host.stop('A')).rejects.toBe(failure)
          await expect(host.reconcile(vault, 'open')).rejects.toBe(failure)
          expect(sessions.has(started.sessionId)).toBe(true)
          expect(terminals.launchedFor(started.sessionId)).toBe(started.terminalId)
        }
        expect(dispose).toHaveBeenCalledOnce()
        expect(pty.kill).not.toHaveBeenCalled()
      } finally {
        proof.resolve()
        exit({ exitCode: 0 })
        vi.useRealTimers()
      }
    },
  )

  it('aborts a settings-disabled activation before its queued cleanup can begin', async () => {
    let context: PluginCtx | undefined
    let entered!: () => void
    let release!: () => void
    const active = new Promise<void>((resolve) => (entered = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      async activate(ctx) {
        context = ctx
        entered()
        await held
        return () => {}
      },
    }
    const root = await tempDir()
    const { host } = rig({ plugins: [plugin] })
    const opening = host.reconcile(openVault('A', root), 'open')
    await active
    await writeVaultSettings(root, { committed: { plugins: { fake: false } } })
    const disabling = host.reconcile(openVault('A', root), 'settings')
    await vi.waitFor(() => expect(context!.activationSignal.aborted).toBe(true))
    release()
    await Promise.all([opening, disabling])
    await expect(host.reconcile(openVault('A', root), 'open')).resolves.toBeUndefined()
  })

  it('latches failed cleanup when activation itself rejects', async () => {
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        ctx.register(['fake'], {})
        throw new Error('activation failed')
      },
    }
    const root = await tempDir()
    const registry = createCapabilityRegistry()
    vi.spyOn(registry, 'register').mockReturnValue(() => {
      throw new Error('registration cleanup failed')
    })
    const { host } = rig({ plugins: [plugin], registry })
    const activation = host.reconcile(openVault('A', root), 'open')
    await expect(activation).rejects.toMatchObject({
      message: 'plugin fake activation cleanup failed',
      errors: [
        expect.objectContaining({ message: 'activation failed' }),
        expect.objectContaining({ message: 'registration cleanup failed' }),
      ],
    })
    await expect(host.stop('A')).rejects.toThrow('plugin fake activation cleanup failed')
  })

  it('aborts synchronously, joins repeated stop, and blocks replacement after failed cleanup', async () => {
    const contexts: PluginCtx[] = []
    let starts = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        contexts.push(ctx)
        starts += 1
        return async () => {
          await gate
          throw new Error('cleanup failed')
        }
      },
    }
    const root = await tempDir()
    const { host, enter } = rig({ plugins: [plugin] })
    await enter(openVault('A', root))
    const first = host.stop('A')
    expect(contexts[0]!.activationSignal.aborted).toBe(true)
    const firstResult = first.then(
      () => null,
      (err: unknown) => err,
    )
    const second = host.stop('A')
    const secondResult = second.then(
      () => null,
      (err: unknown) => err,
    )
    release()
    const failure = await firstResult
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      message: 'plugins in A failed to stop',
      errors: [
        expect.objectContaining({
          message: 'plugin fake teardown failed',
          errors: [expect.objectContaining({ message: 'cleanup failed' })],
        }),
      ],
    })
    expect(await secondResult).toBe(failure)
    await expect(host.stop('A')).rejects.toBe(failure)
    await expect(host.reconcile(openVault('A', root), 'open')).rejects.toBe(failure)
    expect(starts).toBe(1)
  })
})

function repairGate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('admission revocation across queued activation work', () => {
  it.each(['stop', 'stopAll', 'self'] as const)(
    'revokes pending registered capabilities on %s invalidation',
    async (method) => {
      const entered = repairGate()
      const release = repairGate()
      let context!: PluginCtx
      const plugin: MainPlugin = {
        info: { id: 'fake', label: 'Fake', default: true },
        async activate(ctx) {
          context = ctx
          ctx.register(['fake'], {
            'fake.ping': cap({
              doors: ['ui', 'cli'],
              cli: { args: [], summary: 'probe' },
              params: noParams,
              run: async () => 'pong',
            }),
          })
          entered.resolve()
          await release.promise
          return () => {}
        },
      }
      const root = await tempDir()
      const { host, capabilities, registry } = rig({ plugins: [plugin], roots: { A: root } })
      const opening = host.reconcile(openVault('A', root), 'open')
      await entered.promise
      const stopping =
        method === 'stop'
          ? host.stop('A')
          : method === 'stopAll'
            ? host.stopAll()
            : Promise.resolve(context.invalidateActivation())
      try {
        expect(context.activationSignal.aborted).toBe(true)
        expect(registry.has('fake.ping', 'A')).toBe(true)
        for (const door of ['ui', 'cli'] as const) {
          const untrusted = {
            door,
            remote: 'A',
            name: 'fake.ping',
            params: {},
            finalization: true,
            allowDrain: true,
            beforeInvoke: async () => {},
          }
          await expect(capabilities.dispatch(untrusted)).rejects.toThrow('no such method')
        }
      } finally {
        release.resolve()
        await Promise.all([opening, stopping])
        await host.stopAll()
      }
    },
  )

  it('rechecks admission after ordinary target validation yields', async () => {
    const entered = repairGate()
    const release = repairGate()
    const { host, enter, capabilities } = rig()
    const root = await tempDir()
    await enter(openVault('o/r', root))
    const calling = capabilities.dispatch({
      door: 'ui',
      remote: 'o/r',
      name: 'fake.ping',
      params: {},
      beforeInvoke: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const result = calling.then(
      () => 'accepted',
      () => 'refused',
    )
    await entered.promise
    const stopping = host.stop('o/r')
    release.resolve()
    expect(await result).toBe('refused')
    await stopping
  })

  it.each(['settings', 'snapshot'] as const)(
    'cancels immediately and replaces, never reuses, a rapidly reenabled %s activation',
    async (why) => {
      const entered = repairGate()
      const release = repairGate()
      const contexts: PluginCtx[] = []
      let disposed = 0
      const fake: MainPlugin = {
        info: { id: 'fake', label: 'Fake', default: true },
        activate(ctx) {
          contexts.push(ctx)
          ctx.register(['fake'], {
            'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => contexts.length }),
          })
          return () => {
            disposed++
          }
        },
      }
      const blocker: MainPlugin = {
        info: { id: 'blocker', label: 'Blocker', default: true },
        activate() {
          return async () => {
            entered.resolve()
            await release.promise
          }
        },
      }
      const root = await tempDir()
      const { host, capabilities } = rig({ plugins: [fake, blocker], roots: { A: root } })
      const vault = openVault('A', root)
      await host.reconcile(vault, 'open')
      const pending: Promise<void>[] = []
      try {
        await writeVaultSettings(root, { committed: { plugins: { blocker: false } } })
        const blocking = host.reconcile(vault, why)
        pending.push(blocking)
        await entered.promise
        await writeVaultSettings(root, { committed: { plugins: { blocker: false, fake: false } } })
        const disabling = host.reconcile(vault, why)
        pending.push(disabling)
        await vi.waitFor(() => expect(contexts[0]!.activationSignal.aborted).toBe(true))
        expect(disposed).toBe(0)
        await expect(
          capabilities.dispatch({ door: 'ui', remote: 'A', name: 'fake.ping', params: {} }),
        ).rejects.toThrow('no such method')
        await writeVaultSettings(root, { committed: { plugins: { blocker: false, fake: true } } })
        const enabling = host.reconcile(vault, why)
        pending.push(enabling)
        release.resolve()
        await Promise.all([blocking, disabling, enabling])
        expect(disposed).toBe(1)
        expect(contexts).toHaveLength(2)
        expect(contexts[1]!.activationSignal.aborted).toBe(false)
        contexts[0]!.invalidateActivation()
        expect(
          (await capabilities.dispatch({ door: 'ui', remote: 'A', name: 'fake.ping', params: {} }))
            .value,
        ).toBe(2)
      } finally {
        release.resolve()
        await Promise.allSettled(pending)
        await host.stopAll()
      }
    },
  )

  it.each(['stop', 'stopAll'] as const)(
    'retains a cancelled-start disposer failure through queued %s, repeated stops and restart',
    async (method) => {
      const entered = repairGate()
      const release = repairGate()
      const failure = new Error('unproven cancelled startup cleanup')
      let starts = 0
      const plugin: MainPlugin = {
        info: { id: 'fake', label: 'Fake', default: true },
        async activate() {
          starts++
          entered.resolve()
          await release.promise
          return () => {
            throw failure
          }
        },
      }
      const root = await tempDir()
      const { host } = rig({ plugins: [plugin], roots: { A: root } })
      const vault = openVault('A', root)
      const opening = host.reconcile(vault, 'open').catch((err: unknown) => err)
      await entered.promise
      const first = (method === 'stop' ? host.stop('A') : host.stopAll()).catch(
        (err: unknown) => err,
      )
      const second = host.stop('A').catch((err: unknown) => err)
      release.resolve()
      expect(await opening).toMatchObject({ errors: [failure] })
      expect(await first).toBeInstanceOf(AggregateError)
      expect(await second).toBeInstanceOf(AggregateError)
      await expect(host.stop('A')).rejects.toMatchObject({ errors: [failure] })
      await expect(host.stopAll()).rejects.toThrow('failed to stop')
      await expect(host.reconcile(vault, 'open')).rejects.toMatchObject({ errors: [failure] })
      expect(starts).toBe(1)
    },
  )
})

describe('overlapping cancellation cohorts', () => {
  it.each([
    ['settings', false],
    ['snapshot', false],
    ['settings', true],
    ['snapshot', true],
  ] as const)('discards a stale %s read after stop, with replacement %s', async (why, reopen) => {
    const entered = repairGate()
    const release = repairGate()
    const root = await tempDir('holi-573-racefix-')
    let holdNext = false
    const h = rig({
      roots: { A: root },
      readSettings: async (at) => {
        const settings = await readVaultSettings(at)
        if (holdNext) {
          holdNext = false
          entered.resolve()
          await release.promise
        }
        return settings
      },
    })
    const vault = openVault('A', root)
    await h.host.reconcile(vault, 'open')
    // An enabled stale read must not restart a stopped vault; a disabled
    // stale read must not cancel an enabled replacement activation.
    await turn(root, !reopen)
    holdNext = true
    const stale = h.host.reconcile(vault, why)
    try {
      await entered.promise
      await h.host.stop('A')
      if (reopen) {
        await turn(root, true)
        await h.host.reconcile(vault, 'open')
      }
      const current = h.ctx()
      release.resolve()
      await stale
      expect(h.calls).toEqual({ started: reopen ? 2 : 1, stopped: 1 })
      expect(h.registry.has('fake.ping', 'A')).toBe(reopen)
      expect(current.activationSignal.aborted).toBe(!reopen)
      if (reopen) {
        expect(
          (
            await h.capabilities.dispatch({
              door: 'ui',
              remote: 'A',
              name: 'fake.ping',
              params: {},
            })
          ).value,
        ).toBe('pong:A')
      }
    } finally {
      release.resolve()
      await Promise.allSettled([stale])
      await h.host.stopAll()
    }
  })

  it.each(['stop', 'settings'] as const)(
    'preserves a queued recording handoff when stopAll joins %s disposal',
    async (first) => {
      const disposing = repairGate()
      const releaseDispose = repairGate()
      const outbound = repairGate()
      const releaseOutbound = repairGate()
      const contexts = new Map<string, PluginCtx>()
      const transcribed: string[] = []
      const base: MainPlugin = {
        info: { id: 'base', label: 'Base', default: true },
        activate(ctx) {
          ctx.register(['transcribe'], {
            'transcribe.accept': cap({
              doors: ['ui'],
              params: noParams,
              run: async () => void transcribed.push(ctx.remote),
            }),
          })
          return () => {}
        },
      }
      const recorder: MainPlugin = {
        info: { id: 'fake', label: 'Recorder', default: true, requires: ['base'] },
        activate(ctx) {
          contexts.set(ctx.remote, ctx)
          ctx.register(['fake'], {
            'fake.finalAudio': cap({
              doors: ['ui'],
              drain: true,
              params: noParams,
              run: async () => ctx.call('transcribe.accept', {}),
            }),
          })
          return async () => {
            if (ctx.remote !== 'A') return
            ctx.emit('A', 'recording-stop', null)
            disposing.resolve()
            await releaseDispose.promise
          }
        },
      }
      const a = await tempDir('holi-573-racefix-')
      const b = await tempDir('holi-573-racefix-')
      const h = rig({
        plugins: [base, recorder],
        roots: { A: a, B: b },
        rootFor: async (remote) => {
          if (remote === 'A') {
            outbound.resolve()
            await releaseOutbound.promise
          }
          return remote === 'A' ? a : b
        },
      })
      const vault = openVault('A', a)
      await h.host.reconcile(vault, 'open')
      await h.host.reconcile(openVault('B', b), 'open')
      if (first === 'settings') await turn(a, false)
      const pending = [first === 'stop' ? h.host.stop('A') : h.host.reconcile(vault, 'settings')]
      try {
        await disposing.promise
        await outbound.promise
        pending.push(h.host.stopAll(), h.host.stop('A'), h.host.stopAll())
        // All newly stopped remotes are cancelled before any held disposer.
        expect(contexts.get('B')!.activationSignal.aborted).toBe(true)
        releaseOutbound.resolve()
        await vi.waitFor(() =>
          expect(h.sent.map((item) => item.event.name)).toContain('recording-stop'),
        )
        await h.capabilities.dispatch({
          door: 'ui',
          remote: 'A',
          name: 'fake.finalAudio',
          params: {},
        })
        expect(transcribed).toEqual(['A'])
        releaseDispose.resolve()
        await Promise.all(pending)
        expect(h.registry.has('fake.finalAudio', 'A')).toBe(false)
        expect(h.registry.has('fake.finalAudio', 'B')).toBe(false)
      } finally {
        releaseOutbound.resolve()
        releaseDispose.resolve()
        await Promise.allSettled(pending)
        await h.host.stopAll()
      }
    },
  )

  it('keeps invalidated providers finalizable after an overlapping startup is cancelled', async () => {
    const starting = repairGate()
    const releaseStart = repairGate()
    const invalidated = repairGate()
    const disposing = repairGate()
    const releaseDispose = repairGate()
    const cleaned: string[] = []
    let providerStarts = 0
    let dependentStarts = 0
    const base: MainPlugin = {
      info: { id: 'base', label: 'Base', default: true },
      activate(ctx) {
        providerStarts++
        ctx.activationSignal.addEventListener('abort', invalidated.resolve, { once: true })
        ctx.register(['base'], {
          'base.finish': cap({
            doors: ['ui', 'cli'],
            cli: { args: [], summary: 'finalize' },
            params: noParams,
            run: async () => {
              const head = await ctx.head()
              cleaned.push(head)
              return head
            },
          }),
        })
        return () => {}
      },
    }
    const dependent: MainPlugin = {
      info: { id: 'fake', label: 'Dependent', default: true, requires: ['base'] },
      activate(ctx) {
        dependentStarts++
        return async () => {
          disposing.resolve()
          await releaseDispose.promise
          await ctx.call('base.finish', {})
        }
      },
    }
    const late: MainPlugin = {
      info: { id: 'late', label: 'Late', default: false },
      async activate() {
        starting.resolve()
        await releaseStart.promise
        return () => {}
      },
    }
    const root = await tempDir('holi-573-racefix-')
    const h = rig({ plugins: [base, dependent, late], roots: { A: root } })
    const vault = openVault('A', root)
    await h.host.reconcile(vault, 'open')
    await writeVaultSettings(root, { committed: { plugins: { late: true } } })
    const opening = h.host.reconcile(vault, 'settings')
    const pending: Promise<unknown>[] = [opening]
    try {
      await starting.promise
      await writeVaultSettings(root, { committed: { plugins: { base: false } } })
      // Consume rejection immediately, so a failed disposer never leaks one.
      const disabling = h.host.reconcile(vault, 'settings').then(
        () => null,
        (err: unknown) => err,
      )
      pending.push(disabling)
      await invalidated.promise
      releaseStart.resolve()
      await opening
      await disposing.promise
      expect(h.registry.has('base.finish', 'A')).toBe(true)
      for (const door of ['ui', 'cli'] as const) {
        await expect(
          h.capabilities.dispatch({
            door,
            remote: 'A',
            name: 'base.finish',
            params: {},
          }),
        ).rejects.toThrow('no such method')
      }
      releaseDispose.resolve()
      expect(await disabling).toBeNull()
      expect(cleaned).toEqual(['sha'])
      expect(h.registry.has('base.finish', 'A')).toBe(false)
      await writeVaultSettings(root, { committed: { plugins: { base: true, late: false } } })
      await h.host.reconcile(vault, 'settings')
      expect(providerStarts).toBe(2)
      expect(dependentStarts).toBe(2)
      expect(h.host.failures('A')).toEqual({})
      expect(
        (
          await h.capabilities.dispatch({
            door: 'cli',
            remote: 'A',
            name: 'base.finish',
            params: {},
          })
        ).value,
      ).toBe('sha')
    } finally {
      releaseStart.resolve()
      releaseDispose.resolve()
      await Promise.allSettled(pending)
      await h.host.stopAll().catch(() => {})
    }
  })
})

describe('stopped lifetimes and superseded configuration admission', () => {
  it.each([
    ['settings', 'during'],
    ['snapshot', 'during'],
    ['settings', 'after'],
    ['snapshot', 'after'],
  ] as const)('does not let %s admitted %s stop reopen a lifetime', async (why, admission) => {
    const disposing = repairGate()
    const release = repairGate()
    const starts: string[] = []
    const stops: string[] = []
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        starts.push(ctx.remote)
        ctx.register(['fake'], {
          'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => ctx.remote }),
        })
        return async () => {
          if (ctx.remote === 'A') {
            disposing.resolve()
            await release.promise
          }
          stops.push(ctx.remote)
        }
      },
    }
    const a = await tempDir('holi-573-admission-')
    const b = await tempDir('holi-573-admission-')
    const h = rig({ plugins: [plugin], roots: { A: a, B: b } })
    const vault = openVault('A', a)
    await h.host.reconcile(vault, 'open')
    await h.host.reconcile(openVault('B', b), 'open')
    const pending = [h.host.stop('A')]
    try {
      await disposing.promise
      if (admission === 'after') {
        release.resolve()
        await pending[0]
      }
      pending.push(h.host.reconcile(vault, why))
      expect(starts).toEqual(['A', 'B'])
      expect(
        (
          await h.capabilities.dispatch({
            door: 'ui',
            remote: 'B',
            name: 'fake.ping',
            params: {},
          })
        ).value,
      ).toBe('B')
      release.resolve()
      await Promise.all(pending)
      expect(starts).toEqual(['A', 'B'])
      expect(stops).toEqual(['A'])
      await h.host.reconcile(vault, why)
      expect(starts).toEqual(['A', 'B'])
      await expect(
        h.capabilities.dispatch({ door: 'ui', remote: 'A', name: 'fake.ping', params: {} }),
      ).rejects.toThrow('no such method')
      await h.host.reconcile(vault, 'open')
      expect(starts).toEqual(['A', 'B', 'A'])
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await h.host.stopAll()
    }
  })

  it('queues explicit reopening behind proven prior cleanup', async () => {
    const disposing = repairGate()
    const release = repairGate()
    const starts: PluginCtx[] = []
    const root = await tempDir('holi-573-admission-')
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      activate(ctx) {
        starts.push(ctx)
        return async () => {
          disposing.resolve()
          await release.promise
        }
      },
    }
    const h = rig({ plugins: [plugin], roots: { A: root } })
    const vault = openVault('A', root)
    await h.host.reconcile(vault, 'open')
    const pending = [h.host.stop('A')]
    try {
      await disposing.promise
      pending.push(h.host.reconcile(vault, 'settings'), h.host.reconcile(vault, 'open'))
      expect(starts).toHaveLength(1)
      release.resolve()
      await Promise.all(pending)
      expect(starts).toHaveLength(2)
      expect(starts[0]!.activationSignal.aborted).toBe(true)
      expect(starts[1]!.activationSignal.aborted).toBe(false)
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await h.host.stopAll()
    }
  })

  it.each(['settings', 'snapshot'] as const)(
    'retires stale joining work as soon as a newer %s is admitted, before its read finishes',
    async (why) => {
      const disposing = repairGate()
      const releaseDispose = repairGate()
      const reading = repairGate()
      const releaseRead = repairGate()
      let holdRead = false
      const started: string[] = []
      const root = await tempDir('holi-573-admission-')
      const blocker: MainPlugin = {
        info: { id: 'blocker', label: 'Blocker', default: true },
        activate() {
          return async () => {
            disposing.resolve()
            await releaseDispose.promise
          }
        },
      }
      const joining = (id: string): MainPlugin => ({
        info: { id, label: id, default: false },
        activate(ctx) {
          started.push(id)
          ctx.register([id], {
            [`${id}.ping`]: cap({ doors: ['ui'], params: noParams, run: async () => id }),
          })
          return () => {}
        },
      })
      const h = rig({
        plugins: [blocker, joining('agentprobe'), joining('allowed')],
        roots: { A: root },
        readSettings: async (at) => {
          const settings = await readVaultSettings(at)
          if (holdRead) {
            holdRead = false
            reading.resolve()
            await releaseRead.promise
          }
          return settings
        },
      })
      const vault = openVault('A', root)
      await h.host.reconcile(vault, 'open')
      await writeVaultSettings(root, {
        committed: { plugins: { blocker: false, agentprobe: true } },
      })
      const older = h.host.reconcile(vault, why)
      const pending = [older]
      try {
        await disposing.promise
        await writeVaultSettings(root, {
          committed: { plugins: { blocker: false, agentprobe: false, allowed: true } },
        })
        holdRead = true
        pending.push(h.host.reconcile(vault, why))
        await reading.promise
        releaseDispose.resolve()
        await older
        expect(started).toEqual([])
        expect(h.registry.has('agentprobe.ping', 'A')).toBe(false)
        releaseRead.resolve()
        await Promise.all(pending)
        expect(started).toEqual(['allowed'])
        expect(
          (
            await h.capabilities.dispatch({
              door: 'ui',
              remote: 'A',
              name: 'allowed.ping',
              params: {},
            })
          ).value,
        ).toBe('allowed')
      } finally {
        releaseRead.resolve()
        releaseDispose.resolve()
        await Promise.allSettled(pending)
        await h.host.stopAll()
      }
    },
  )

  it('does not let an older same-lifetime configuration read cancel the latest enabled activation', async () => {
    const reading = repairGate()
    const release = repairGate()
    let holdRead = false
    const root = await tempDir('holi-573-admission-')
    const h = rig({
      roots: { A: root },
      readSettings: async (at) => {
        const settings = await readVaultSettings(at)
        if (holdRead) {
          holdRead = false
          reading.resolve()
          await release.promise
        }
        return settings
      },
    })
    const vault = openVault('A', root)
    await h.host.reconcile(vault, 'open')
    const original = h.ctx()
    await turn(root, false)
    holdRead = true
    const stale = h.host.reconcile(vault, 'settings')
    try {
      await reading.promise
      await turn(root, true)
      await h.host.reconcile(vault, 'settings')
      release.resolve()
      await stale
      expect(original.activationSignal.aborted).toBe(false)
      expect(h.ctx()).toBe(original)
      expect(h.calls).toEqual({ started: 1, stopped: 0 })
      expect(
        (await h.capabilities.dispatch({ door: 'ui', remote: 'A', name: 'fake.ping', params: {} }))
          .value,
      ).toBe('pong:A')
    } finally {
      release.resolve()
      await Promise.allSettled([stale])
      await h.host.stopAll()
    }
  })

  it('aborts a pending startup at configuration admission without awaiting its settings read', async () => {
    const starting = repairGate()
    const releaseStart = repairGate()
    const reading = repairGate()
    const releaseRead = repairGate()
    let holdRead = false
    let context!: PluginCtx
    const root = await tempDir('holi-573-admission-')
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: true },
      async activate(ctx) {
        context = ctx
        starting.resolve()
        await releaseStart.promise
        return () => {}
      },
    }
    const h = rig({
      plugins: [plugin],
      readSettings: async (at) => {
        const settings = await readVaultSettings(at)
        if (holdRead) {
          holdRead = false
          reading.resolve()
          await releaseRead.promise
        }
        return settings
      },
    })
    const vault = openVault('A', root)
    const pending = [h.host.reconcile(vault, 'open')]
    try {
      await starting.promise
      await turn(root, false)
      holdRead = true
      pending.push(h.host.reconcile(vault, 'settings'))
      expect(context.activationSignal.aborted).toBe(true)
      await reading.promise
    } finally {
      releaseRead.resolve()
      releaseStart.resolve()
      await Promise.allSettled(pending)
      await h.host.stopAll()
    }
  })
})

describe('agent turn sync holds', () => {
  // The native adapter supplies an explicit physical receipt. No PIDs or OS
  // processes stand in for proof in these host/coordinator integration tests.
  function openWriter(ctx: PluginCtx) {
    const brackets = createManagedTurnBrackets()
    const coordinator = createTurnCoordinator({
      vault: () => ({ ...ctx, claimManagedTurn: brackets.claimManagedTurn }),
      turnLogFor: openTurnLog,
    })
    const turn = brackets.begin('writer', (id, edge) => coordinator[edge](id))
    return {
      async forget(physical: () => Promise<void>) {
        await physical()
        turn.forget()
      },
      async drain(physical: () => Promise<void>, output: () => void = () => {}) {
        try {
          await physical()
          try {
            output()
          } catch (error) {
            turn.forget()
            throw error
          }
          await turn.end()
        } finally {
          await coordinator.drain()
        }
      },
    }
  }

  it.skipIf(process.platform === 'win32').each(['throws', 'reports'] as const)(
    'keeps the original sync hold and stop failure when an unproven writer %s',
    async (mode) => {
      const roots = { A: await tempDir(), B: await tempDir() }
      const aSync: string[] = []
      const bSync: string[] = []
      const cause = new Error('physical writer proof unavailable')
      const allowProof = repairGate()
      const contexts = new Map<string, PluginCtx>()
      const starts: string[] = []
      let forgetA!: ReturnType<typeof openWriter>['forget']
      const agent: MainPlugin = {
        info: { id: 'fake', label: 'Agent fixture', default: true },
        activate(ctx) {
          starts.push(ctx.remote)
          contexts.set(ctx.remote, ctx)
          if (ctx.remote !== 'A') return () => {}
          ctx.register(['fake'], {
            'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'started' }),
          })
          const writer = openWriter(ctx)
          forgetA = writer.forget
          ctx.pauseSync('ordinary hold on the same activation')
          return () =>
            writer
              .drain(async () => {
                await allowProof.promise
                throw cause
              })
              .catch((error: unknown) => {
                if (mode === 'throws') throw error
                ctx.reportDrainFailure(error)
                ctx.reportDrainFailure(new Error('secondary drain failure'))
              })
        },
      }
      const { host, registry } = rig({ plugins: [agent], roots })
      const a = openVault('A', roots.A, aSync)
      await host.reconcile(a, 'open')
      await host.reconcile(openVault('B', roots.B, bSync), 'open')
      const stopping = host.stop('A').catch((error: unknown) => error)
      allowProof.resolve()
      const failure = await stopping
      if (mode === 'reports') expect(failure).toBe(cause)
      else expect(failure).toMatchObject({ errors: [expect.objectContaining({ errors: [cause] })] })
      // Cleanup drops the ordinary hold and restores the surviving reason.
      expect(aSync).toEqual([
        'pause the assistant is working',
        'pause ordinary hold on the same activation',
        'pause the assistant is working',
      ])
      expect(registry.has('fake.ping', 'A')).toBe(false)
      expect(await openTurnLog(roots.A).list()).toEqual([])
      await expect(host.stop('A')).rejects.toBe(failure)
      await expect(host.reconcile(a, 'open')).rejects.toBe(failure)
      expect(starts).toEqual(['A', 'B'])
      expect(aSync).toHaveLength(3)

      const writerB = openWriter(contexts.get('B')!)
      await writerB.drain(async () => {})
      await host.stop('B')
      expect(bSync).toEqual(['pause the assistant is working', 'resume'])
      expect(await openTurnLog(roots.B).list()).toMatchObject([{ sessionId: 'writer' }])
      expect(aSync).toHaveLength(3)

      // If the owner later obtains positive proof, its release still works
      // against the same hold stack without reopening the failed activation.
      await forgetA(async () => {})
      await forgetA(async () => {})
      expect(aSync.slice(3)).toEqual(['resume'])
      await expect(host.stop('A')).rejects.toBe(failure)
      expect(await openTurnLog(roots.A).list()).toEqual([])
    },
  )

  it.each(['output failure', 'success'] as const)(
    'releases after positive physical proof with %s',
    async (result) => {
      const root = await tempDir()
      const sync: string[] = []
      const outputFailure = new Error('output could not be collected')
      const plugin: MainPlugin = {
        info: { id: 'fake', label: 'Agent fixture', default: true },
        activate(ctx) {
          const writer = openWriter(ctx)
          return () =>
            writer.drain(
              async () => {},
              () => {
                if (result === 'output failure') throw outputFailure
              },
            )
        },
      }
      const { host } = rig({ plugins: [plugin] })
      const vault = openVault('A', root, sync)
      await host.reconcile(vault, 'open')
      expect(sync).toEqual(['pause the assistant is working'])
      const stopping = host.stop('A')
      if (result === 'output failure') {
        await expect(stopping).rejects.toMatchObject({
          errors: [expect.objectContaining({ errors: [outputFailure] })],
        })
        expect(await openTurnLog(root).list()).toEqual([])
      } else {
        await stopping
        expect(await openTurnLog(root).list()).toMatchObject([{ sessionId: 'writer' }])
      }
      expect(sync).toEqual(['pause the assistant is working', 'resume'])
    },
  )

  it.skipIf(process.platform === 'win32').each(['unknown', 'positive'] as const)(
    'handles failed activation with %s physical proof',
    async (proof) => {
      const root = await tempDir()
      const sync: string[] = []
      const cause = new Error('activation left an unproven writer')
      const plugin: MainPlugin = {
        info: { id: 'fake', label: 'Agent fixture', default: true },
        async activate(ctx) {
          const writer = openWriter(ctx)
          await writer.drain(
            async () => {
              if (proof === 'unknown') throw cause
            },
            () => {
              throw cause
            },
          )
          return () => {}
        },
      }
      const { host } = rig({ plugins: [plugin] })
      const vault = openVault('A', root, sync)
      if (proof === 'unknown') {
        await expect(host.reconcile(vault, 'open')).rejects.toBe(cause)
        await expect(host.stop('A')).rejects.toBe(cause)
        await expect(host.reconcile(vault, 'open')).rejects.toBe(cause)
        expect(sync).toEqual(['pause the assistant is working'])
      } else {
        await host.reconcile(vault, 'open')
        expect(host.failures('A')).toEqual({ fake: cause.message })
        await host.stop('A')
        expect(sync).toEqual(['pause the assistant is working', 'resume'])
      }
      expect(await openTurnLog(root).list()).toEqual([])
    },
  )

  it('still undoes an ordinary plugin hold when its disposer throws', async () => {
    const root = await tempDir()
    const sync: string[] = []
    const failure = new Error('ordinary cleanup failed')
    const plugin: MainPlugin = {
      info: { id: 'fake', label: 'Ordinary plugin', default: true },
      activate(ctx) {
        ctx.pauseSync('ordinary hold')
        return () => {
          throw failure
        }
      },
    }
    const { host } = rig({ plugins: [plugin] })
    await host.reconcile(openVault('A', root, sync), 'open')
    await expect(host.stop('A')).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [failure] })],
    })
    expect(sync).toEqual(['pause ordinary hold', 'resume'])
  })
})

describe('sticky cleanup failure authority', () => {
  it.each(['stop', 'stopAll'] as const)(
    '%s revokes retained providers synchronously without unsafe disposal after settings cleanup fails',
    async (method) => {
      const contexts = new Map<string, PluginCtx>()
      const disposed: string[] = []
      const failure = new Error('dependent cleanup unproven')
      const provider: MainPlugin = {
        info: { id: 'provider', label: 'Provider', default: true },
        activate(ctx) {
          contexts.set(ctx.remote, ctx)
          ctx.register(['provider'], {
            'provider.ping': cap({
              doors: ['ui', 'cli'],
              cli: { args: [], summary: 'probe' },
              params: noParams,
              run: async () => ctx.head(),
            }),
          })
          return () => {
            disposed.push(ctx.remote)
          }
        },
      }
      const dependent: MainPlugin = {
        info: { id: 'fake', label: 'Dependent', default: true, requires: ['provider'] },
        activate(ctx) {
          return () => {
            if (ctx.remote === 'A') throw failure
          }
        },
      }
      const a = await tempDir('holi-573-admission-')
      const b = await tempDir('holi-573-admission-')
      const h = rig({ plugins: [provider, dependent], roots: { A: a, B: b } })
      const vault = openVault('A', a)
      await h.host.reconcile(vault, 'open')
      await h.host.reconcile(openVault('B', b), 'open')
      try {
        await turn(a, false)
        const sticky = await h.host.reconcile(vault, 'settings').catch((err: unknown) => err)
        expect(sticky).toMatchObject({ errors: [failure] })
        const stopping = (method === 'stop' ? h.host.stop('A') : h.host.stopAll()).catch(
          (err: unknown) => err,
        )
        expect(contexts.get('A')!.activationSignal.aborted).toBe(true)
        const result = await stopping
        if (method === 'stop') expect(result).toBe(sticky)
        else expect(result).toMatchObject({ errors: [sticky] })
        expect(disposed).not.toContain('A')
        for (const door of ['ui', 'cli'] as const) {
          await expect(
            h.capabilities.dispatch({ door, remote: 'A', name: 'provider.ping', params: {} }),
          ).rejects.toThrow('no such method')
        }
        await expect(h.host.stop('A')).rejects.toBe(sticky)
        if (method === 'stopAll') await h.host.reconcile(openVault('B', b), 'open')
        expect(
          (
            await h.capabilities.dispatch({
              door: 'ui',
              remote: 'B',
              name: 'provider.ping',
              params: {},
            })
          ).value,
        ).toBe('sha')
      } finally {
        await h.host.stop('B')
        await h.host.stopAll().catch(() => {})
      }
    },
  )

  it.each(['stop', 'stopAll'] as const)(
    '%s preserves an approved finalization and queued recording output when a drain reports sticky failure',
    async (method) => {
      const finalizing = repairGate()
      const release = repairGate()
      const failure = new Error('unproven recording drain')
      const completed: string[] = []
      let providerCtx!: PluginCtx
      const provider: MainPlugin = {
        info: { id: 'provider', label: 'Provider', default: true },
        activate(ctx) {
          providerCtx = ctx
          ctx.register(['provider'], {
            'provider.final': cap({
              doors: ['ui'],
              params: noParams,
              run: async () => {
                finalizing.resolve()
                await release.promise
                completed.push(await ctx.head())
                await ctx.commitNow()
                return 'done'
              },
            }),
          })
          return () => {
            throw new Error('unsafe provider disposal')
          }
        },
      }
      const dependent: MainPlugin = {
        info: { id: 'fake', label: 'Dependent', default: true, requires: ['provider'] },
        activate(ctx) {
          return async () => {
            ctx.reportDrainFailure(failure)
            ctx.emit(ctx.remote, 'recording-stop', null)
            expect(await ctx.call('provider.final', {})).toBe('done')
            throw failure
          }
        },
      }
      const root = await tempDir('holi-573-admission-')
      const h = rig({ plugins: [provider, dependent], roots: { A: root } })
      const vault = openVault('A', root)
      await h.host.reconcile(vault, 'open')
      await turn(root, false)
      const disabling = h.host.reconcile(vault, 'settings').catch((err: unknown) => err)
      try {
        await finalizing.promise
        const stopping = (method === 'stop' ? h.host.stop('A') : h.host.stopAll()).catch(
          (err: unknown) => err,
        )
        expect(providerCtx.activationSignal.aborted).toBe(true)
        await stopping
        await expect(
          h.capabilities.dispatch({ door: 'ui', remote: 'A', name: 'provider.final', params: {} }),
        ).rejects.toThrow('no such method')
        await h.host.stop('A').catch(() => {})
        release.resolve()
        await disabling
        expect(completed).toEqual(['sha'])
        expect(h.sent.map((item) => item.event.name)).toContain('recording-stop')
        expect(h.registry.has('provider.final', 'A')).toBe(true)
      } finally {
        release.resolve()
        await disabling
        await h.host.stopAll().catch(() => {})
      }
    },
  )
})

describe('work across vaults', () => {
  it('runs while some registered vault runs the plugin, and says why', async () => {
    const [a, b] = [await tempDir(), await tempDir()]
    const log: string[] = []
    const whys: (readonly string[])[] = []
    const across: MainPlugin = {
      info: { id: 'fake', label: 'Fake', default: false },
      background: {
        why: 'reminders',
        start: async (ctx) => {
          log.push(`start ${(await ctx.vaults()).map((v) => v.remote).join(' ')}`)
          return () => void log.push('stop')
        },
      },
    }
    const host = createPluginHost({
      plugins: [across],
      registry: createCapabilityRegistry(),
      userData: '/nowhere',
      coreSeeds: [],
      active: () => null,
      rootFor: async () => null,
      events: { send: () => {}, listen: () => () => {}, liveRemote: () => null },
      openAppDoor: () => {
        throw new Error('unused')
      },
      route: () => () => {},
      binDir: () => '/holi/bin',
      githubToken: () => null,
      frameOrigin: () => () => {},
      background: {
        registered: async () => [
          { remote: 'o/a', root: a },
          { remote: 'o/b', root: b },
        ],
        scan: async () => {
          throw new Error('unused')
        },
        open: () => {},
        viewerLogin: () => null,
        onChange: (now) => void whys.push(now),
      },
    })

    await host.syncBackground()
    expect(log).toEqual([])
    expect(whys.at(-1)).toEqual([])

    await turn(b, true)
    await host.syncBackground()
    expect(log).toEqual(['start o/b'])
    expect(whys.at(-1)).toEqual(['reminders'])

    await turn(b, false)
    await host.syncBackground()
    expect(log).toEqual(['start o/b', 'stop'])
    expect(whys.at(-1)).toEqual([])
  })
})
