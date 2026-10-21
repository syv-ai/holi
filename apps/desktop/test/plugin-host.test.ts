/**
 * The plugin host with test-only plugins: enablement gates dispatch and
 * seeding, and what is started follows the open vault's settings.
 */
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
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
  } = {},
) {
  const calls = { started: 0, stopped: 0 }
  const sent: { channel: string; event: PluginEvent }[] = []
  const listeners = new Map<string, (message: unknown) => void>()
  let context: PluginCtx | null = null
  let open: OpenVault | null = null
  const fake: MainPlugin = {
    info: { id: 'fake', label: 'Fake', default: opts.default ?? true },
    seed: { id: 'fake', once: {}, shipped: { [SKILL]: '# fake\n' } },
    activate(ctx) {
      context = ctx
      calls.started += 1
      ctx.register(['fake'], {
        'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'pong' }),
      })
      return () => {
        calls.stopped += 1
      }
    },
  }
  const plugins = opts.plugins ?? [fake]
  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins,
    registry,
    userData: '/nowhere',
    coreSeeds: [coreSeed(plugins.map((p) => p.info))],
    active: () => open,
    rootFor: async (remote) => opts.roots?.[remote] ?? null,
    events: {
      send: (channel, event) => void sent.push({ channel, event }),
      listen: (channel, handler) => {
        listeners.set(channel, handler)
        return () => void listeners.delete(channel)
      },
      liveRemote: () => opts.live ?? null,
    },
    openAppDoor: (opener) => capabilities.openAppDoor(opener),
    route: () => () => {},
    binDir: () => '/holi/bin',
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
  })
  let root = ''
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async () => root,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at) => (await host.enabled(at)).has(plugin),
    claims: (at) => host.scanClaimsFor(at),
  })
  const ping = (at: string) => {
    root = at
    return capabilities.dispatch({ door: 'ui', remote: 'o/r', name: 'fake.ping', params: {} })
  }
  /** What the renderer sends the plugin's main side. */
  const fromRenderer = (message: unknown) => listeners.get('plugin:fake')?.(message)
  /** Make `vault` the open one and reconcile, as the router does after `host.open`. */
  const enter = async (vault: OpenVault | null) => {
    open = vault
    await host.reconcile('open')
  }
  return { host, registry, calls, ping, sent, fromRenderer, enter, ctx: () => context! }
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
  it('starts an enabled plugin once, however often the vault reconciles', async () => {
    const { host, calls, registry, enter } = rig()
    const root = await tempDir()
    await enter(openVault('o/r', root))
    await host.reconcile('snapshot')
    await host.reconcile('settings')
    expect(calls.started).toBe(1)
    expect(registry.pluginOf('fake.ping')).toBe('fake')

    await host.stop()
    expect(calls.stopped).toBe(1)
    expect(registry.has('fake.ping')).toBe(false)
  })

  it('does not start a plugin the vault has off', async () => {
    const { calls, enter } = rig({ default: false })
    await enter(openVault('o/r', await tempDir()))
    expect(calls.started).toBe(0)
  })

  it("refuses a plugin's capability in a vault that has it off", async () => {
    const { ping, enter } = rig()
    const on = await tempDir()
    const off = await tempDir()
    await turn(off, false)
    await enter(openVault('o/r', on))

    expect((await ping(on)).value).toBe('pong')
    await expect(ping(off)).rejects.toThrow('no such method: fake.ping')
  })
})

describe('the lifecycle', () => {
  it('stops a plugin turned off by hand, and starts it again, seeded, when turned back on', async () => {
    const { host, calls, registry, enter } = rig()
    const root = await tempDir()
    await enter(openVault('o/r', root))

    await turn(root, false)
    await host.reconcile('snapshot')
    expect(calls).toEqual({ started: 1, stopped: 1 })
    expect(registry.has('fake.ping')).toBe(false)

    await turn(root, true)
    await host.reconcile('snapshot')
    expect(calls).toEqual({ started: 2, stopped: 1 })
    expect(registry.pluginOf('fake.ping')).toBe('fake')
  })

  it('starts what a plugin requires first, and stops it last', async () => {
    const log: string[] = []
    const plugins = [
      logged(log, 'face', { requires: ['base'] }),
      logged(log, 'skin', { requires: ['face'] }),
      logged(log, 'base'),
    ]
    const { host, enter } = rig({ plugins })
    const root = await tempDir()
    await enter(openVault('o/r', root))
    expect(log).toEqual(['start base', 'start face', 'start skin'])

    log.length = 0
    await writeVaultSettings(root, { committed: { plugins: { base: false } } })
    await host.reconcile('settings')
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
    const { host, enter } = rig({ plugins })
    await enter(openVault('o/r', await tempDir()))
    expect(host.failures('o/r')).toEqual({ base: 'keychain locked', face: 'base did not start.' })

    await host.reconcile('snapshot')
    expect(log).toEqual(['try base'])

    fails = false
    await host.reconcile('settings')
    expect(log).toEqual(['try base', 'try base', 'start face'])
    expect(host.failures('o/r')).toEqual({})
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
    const { host, enter } = rig({ plugins })
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
    await host.stop()
    expect(log.slice(-3)).toEqual(['pause held', 'stop base', 'resume'])
  })
})

describe('plugin events', () => {
  it('reach the renderer only about a vault that runs the plugin, in order', async () => {
    const on = await tempDir()
    const off = await tempDir()
    await turn(off, false)
    const { ctx, sent, enter } = rig({ roots: { 'o/on': on, 'o/off': off } })
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

  it("hear only the open vault's messages", async () => {
    const root = await tempDir()
    const { ctx, fromRenderer, enter } = rig({ roots: { 'o/live': root }, live: 'o/live' })
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
