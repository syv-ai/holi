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
import { writeVaultSettings } from '../src/main/vault/settings'

const SKILL = '.claude/skills/fake/SKILL.md'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-plugin-host-'))
  dirs.push(dir)
  return dir
}

/** An open vault the test drives: what `host.open` would have made active. */
function openVault(remote: string, root: string, log: string[] = []): OpenVault {
  return {
    remote,
    root,
    pause: (reason) => void log.push(`pause ${reason}`),
    resume: () => void log.push('resume'),
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
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
    activity: (entry) => activity.push(entry),
    call:
      opts.call ??
      ((remote, name, params, beforeInvoke) =>
        capabilities.dispatch({
          door: 'ui',
          remote,
          name,
          params,
          beforeInvoke,
        })),
  })
  let root = ''
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async () => root,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at) => (await host.serving(at)).has(plugin),
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
              return { head, nested: nested.value }
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
          expect(result.value).toEqual({ head: 'sha', nested: 'sha' })
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
    expect((await ping(root)).value).toBe('pong')

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
