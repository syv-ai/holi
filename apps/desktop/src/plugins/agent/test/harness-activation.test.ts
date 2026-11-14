import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { createPluginHost } from '../../../main/plugin-host/host'
import { agentMain } from '../main/index'

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('activates the real built-in agent in two vaults and dispatches shared harness config', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'holi-agent-owner-'))
  dirs.push(userData)
  const roots = { A: join(userData, 'vault-a'), B: join(userData, 'vault-b') }
  for (const root of Object.values(roots)) {
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    await writeFile(join(root, '.holi/settings/plugins.yaml'), 'plugins:\n  agent: true\n')
  }
  const sent: { remote: string; name: string }[] = []
  const registry = createCapabilityRegistry()
  const host = createPluginHost({
    plugins: [agentMain],
    registry,
    userData,
    coreSeeds: [],
    active: () => null,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    events: {
      send: (_channel, event) => sent.push({ remote: event.remote, name: event.name }),
      listen: () => () => {},
      liveRemote: () => host.displayed(),
    },
    openAppDoor: () => {
      throw new Error('unused')
    },
    route: () => () => {},
    binDir: () => userData,
    githubToken: () => null,
    frameOrigin: () => () => {},
    notify: () => false,
    focused: () => false,
  })
  const capabilities = createCapabilityHost({
    registry,
    rootFor: async (remote) => roots[remote as keyof typeof roots] ?? null,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async (plugin, root) => (await host.serving(root)).has(plugin),
    claims: (root) => host.scanClaimsFor(root),
  })
  const vault = (remote: 'A' | 'B') => ({
    remote,
    root: roots[remote],
    pause: () => {},
    resume: () => {},
    commitNow: async () => null,
    repo: { head: async () => null },
  })
  try {
    await host.reconcile(vault('A'), 'open')
    await host.reconcile(vault('B'), 'open')
    expect(host.failures('A')).toEqual({})
    expect(host.failures('B')).toEqual({})
    const dispatch = (remote: 'A' | 'B', name: string, params: unknown = {}) =>
      capabilities.dispatch({ door: 'ui', remote, name: `agent.${name}`, params })

    const initialA = await dispatch('A', 'harnesses')
    const initialB = await dispatch('B', 'harnesses')
    expect(initialA.value).toEqual(initialB.value)
    const harness = {
      id: 'integration-test',
      label: 'Integration test',
      command: { bin: 'integration-test', args: [] },
      prompt: { args: ['--prompt', '{prompt}'] },
      resume: { pick: ['--resume'], byId: ['--id', '{id}'] },
      env: { OWNER_TEST: 'shared' },
    }
    await dispatch('A', 'harnessSave', { harness, create: true })
    expect((await dispatch('B', 'harnesses')).value).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ harness: expect.objectContaining({ id: 'integration-test' }) }),
      ]),
    })
    expect(sent).toContainEqual({ remote: 'A', name: 'providers' })
    expect(sent).toContainEqual({ remote: 'B', name: 'providers' })
    await dispatch('B', 'harnessRemove', { id: 'integration-test' })
    expect((await dispatch('A', 'harnesses')).value).not.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ harness: expect.objectContaining({ id: 'integration-test' }) }),
      ]),
    })
    await dispatch('A', 'harnessSave', { harness, create: true })
    await host.stop('A')
    await host.reconcile(vault('A'), 'open')
    expect(host.failures('A')).toEqual({})
    expect((await dispatch('B', 'harnesses')).value).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ harness: expect.objectContaining({ id: 'integration-test' }) }),
      ]),
    })
    await dispatch('B', 'harnessReset')
    expect((await dispatch('A', 'harnesses')).value).not.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ harness: expect.objectContaining({ id: 'integration-test' }) }),
      ]),
    })
  } finally {
    await host.stopAll()
  }
})
