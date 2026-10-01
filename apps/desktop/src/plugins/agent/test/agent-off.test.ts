/**
 * A vault with the agent off: nothing under `.claude/` is seeded, whichever
 * plugin contributes it, and the `agent.*` capabilities are refused. Turning
 * it on seeds `.claude/` once.
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost } from '../../../main/plugin-host/host'
import { coreSeed } from '../../../main/vault/seed/core'
import { writeVaultSettings } from '../../../main/vault/settings'
import { MAIN_PLUGINS } from '../../main'
import { agentCapabilities, AGENT_NAMESPACES } from '../main/host/capabilities'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

it('seeds nothing under .claude/ and refuses agent.* until the agent is on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-agent-off-'))
  dirs.push(root)
  const registry = createCapabilityRegistry()
  registry.register(
    AGENT_NAMESPACES,
    agentCapabilities({
      sessions: {} as never,
      terminals: { list: () => [] } as never,
      liveRemote: () => 'o/r',
      commitNow: async () => null,
    }),
    'agent',
  )
  const host = createPluginHost({
    plugins: MAIN_PLUGINS,
    registry,
    userData: '/nowhere',
    coreSeeds: [coreSeed(MAIN_PLUGINS.map((p) => p.info))],
    active: () => null,
    rootFor: async () => root,
    events: { send: () => {}, listen: () => () => {}, liveRemote: () => null },
    openAppDoor: () => {
      throw new Error('unused')
    },
    route: () => () => {},
    binDir: () => '/holi/bin',
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async () => root,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at) => (await host.enabled(at)).has(plugin),
  })
  const terminals = () =>
    capabilities.dispatch({ door: 'ui', remote: 'o/r', name: 'agent.terminals', params: {} })

  await writeVaultSettings(root, { committed: { plugins: { agent: false } } })
  await host.seed(root)
  expect(await exists(join(root, 'AGENTS.md'))).toBe(true)
  expect(await exists(join(root, '.claude'))).toBe(false)
  await expect(terminals()).rejects.toThrow('no such method: agent.terminals')

  await writeVaultSettings(root, { committed: { plugins: { agent: true } } })
  host.invalidate()
  await host.seed(root)
  const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
  expect(JSON.stringify(settings.hooks)).toContain('google-send-gate')
  expect(await exists(join(root, '.claude/skills/gmail-calendar/SKILL.md'))).toBe(true)
  expect((await terminals()).value).toEqual([])
})
