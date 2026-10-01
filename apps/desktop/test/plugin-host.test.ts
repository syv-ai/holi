/**
 * The plugin host with a test-only plugin: enablement gates dispatch and
 * seeding, a plugin starts once per process, and stops at quit.
 */
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { cap, noParams, type MainPlugin } from '../src/main/plugin-api'
import { createPluginHost } from '../src/main/plugin-host/host'
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

function rig(opts: { default?: boolean } = {}) {
  const calls = { started: 0, stopped: 0 }
  const fake: MainPlugin = {
    info: { id: 'fake', label: 'Fake', default: opts.default ?? true },
    seed: { id: 'fake', once: {}, shipped: { [SKILL]: '# fake\n' } },
    activateApp(ctx) {
      calls.started += 1
      ctx.register(['fake'], {
        'fake.ping': cap({ doors: ['ui'], params: noParams, run: async () => 'pong' }),
      })
      return () => {
        calls.stopped += 1
      }
    },
  }
  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins: [fake],
    registry,
    userData: '/nowhere',
    coreSeeds: [coreSeed([fake.info])],
    liveRoot: () => null,
  })
  let root = ''
  const { dispatch } = createCapabilityHost({
    registry,
    rootFor: async () => root,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at) => (await host.enabled(at)).has(plugin),
  })
  const ping = (at: string) => {
    root = at
    return dispatch({ door: 'ui', remote: 'o/r', name: 'fake.ping', params: {} })
  }
  return { host, registry, calls, ping }
}

const turn = (root: string, on: boolean) =>
  writeVaultSettings(root, { committed: { plugins: { fake: on } } })

describe('the plugin host', () => {
  it('starts an enabled plugin once, however often a vault is entered', async () => {
    const { host, calls, registry } = rig()
    const root = await tempDir()
    await host.enter(root)
    await host.enter(root)
    expect(calls.started).toBe(1)
    expect(registry.pluginOf('fake.ping')).toBe('fake')

    await host.disposeAll()
    expect(calls.stopped).toBe(1)
    expect(registry.has('fake.ping')).toBe(false)
  })

  it('does not start a plugin the vault has off', async () => {
    const { host, calls } = rig({ default: false })
    await host.enter(await tempDir())
    expect(calls.started).toBe(0)
  })

  it("refuses a plugin's capability in a vault that has it off", async () => {
    const { host, ping } = rig()
    const on = await tempDir()
    const off = await tempDir()
    await turn(off, false)
    await host.enter(on)

    expect((await ping(on)).value).toBe('pong')
    await expect(ping(off)).rejects.toThrow('no such method: fake.ping')
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
