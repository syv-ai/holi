/**
 * The agent is built in, and chat is retired: a vault whose `plugins.yaml` an
 * older Holi wrote with `agent: false` and `chat: false` still seeds
 * `.claude/` and serves `agent.*`, and the next write drops the stale pins.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost } from '../../../main/plugin-host/host'
import { install } from '../../../main/plugin-host/installed'
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

it('runs whatever a stale plugins.yaml pins for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-agent-off-'))
  dirs.push(root)
  const registry = createCapabilityRegistry()
  registry.register(
    AGENT_NAMESPACES,
    agentCapabilities({
      sessions: {} as never,
      own: {} as never,
      jobs: {} as never,
      fenced: {} as never,
      providers: [],
      terminals: { list: () => [] } as never,
      liveRemote: () => 'o/r',
      commitNow: async () => null,
      defaultProvider: async () => 'claude' as const,
      unattended: { allowed: async () => true, set: async () => {} },
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
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async () => root,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, at) => (await host.enabled(at)).has(plugin),
    claims: (at) => host.scanClaimsFor(at),
  })
  const terminals = () =>
    capabilities.dispatch({ door: 'ui', remote: 'o/r', name: 'agent.terminals', params: {} })

  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await writeFile(
    join(root, '.holi/settings/plugins.yaml'),
    'plugins:\n  agent: false\n  chat: false\n  google: true\n',
  )
  expect([...(await host.enabled(root))]).toEqual(expect.arrayContaining(['agent']))
  await host.seed(root)
  expect(await exists(join(root, 'AGENTS.md'))).toBe(true)
  const settings = JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))
  expect(JSON.stringify(settings.hooks)).toContain('google-send-gate')
  expect(await exists(join(root, '.claude/skills/gmail-calendar/SKILL.md'))).toBe(true)
  expect((await terminals()).value).toEqual([])

  // Any write regenerates the file whole, without the built-in parts.
  install(MAIN_PLUGINS)
  await writeVaultSettings(root, { committed: { plugins: { pdf: true } } })
  const text = await readFile(join(root, '.holi/settings/plugins.yaml'), 'utf8')
  expect(text).not.toMatch(/\b(agent|chat):/)
  expect(text).toMatch(/^  google: true$/m)
})
