import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginPinPath, type PluginManifest, type PluginPin } from '@holi/shared'
import { createCapabilityHost } from '../src/main/capabilities/dispatch'
import { createCapabilityRegistry, type AnyCapability } from '../src/main/capabilities/registry'
import { noCoreServices } from '../src/main/capabilities/services'
import { installHoliCli } from '../src/main/bridge/cli'
import { publishCliEndpoint, type CliEndpoint } from '../src/main/bridge/cli-endpoint'
import { createBridgeServer, type BridgeServer } from '../src/main/bridge/server'
import { createChecks } from '../src/plugins/community/main/checks'
import {
  communityCapabilities,
  COMMUNITY_NAMESPACES,
} from '../src/plugins/community/main/capabilities'
import { createConsentStore } from '../src/plugins/community/main/consent'
import { createInstallStore } from '../src/plugins/community/main/store'
import { createSupervisor } from '../src/plugins/community/main/supervisor'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const evidence: Array<Record<string, unknown>> = []

async function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { cwd, env })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 1 }
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', args, { cwd }).then(({ stdout }) => stdout.trim())
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-522-cli-')))
  roots.push(root)
  const vaultA = join(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  const userData = join(root, 'user')
  const release = join(userData, 'plugins/demo/release')
  const plugin = join(release, 'demo')
  const skill = 'skills/demo'
  await mkdir(join(plugin, skill), { recursive: true })
  for (const vault of [vaultA, vaultB]) {
    await mkdir(join(vault, '.holi/plugins/demo'), { recursive: true })
    await mkdir(join(vault, '.holi/settings'), { recursive: true })
    await writeFile(join(vault, '.holi/settings/plugins.yaml'), 'plugins:\n  demo: true\n')
  }
  await writeFile(join(plugin, skill, 'SKILL.md'), 'pinned skill\n')
  await writeFile(join(plugin, skill, 'tool.bin'), Buffer.from([0, 1, 255]))
  const manifest: PluginManifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    opens: [],
    skills: [skill],
  }
  await writeFile(join(plugin, 'holi-plugin.json'), JSON.stringify(manifest))
  await git(release, 'init', '-q', '-b', 'main')
  await git(release, 'add', '.')
  await git(
    release,
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@example.test',
    'commit',
    '-qm',
    'release',
  )
  const commit = await git(release, 'rev-parse', 'HEAD')
  const installedRelease = join(userData, 'plugins/demo', commit)
  await rename(release, installedRelease)
  const origin = join(root, 'origin.git')
  await git(installedRelease, 'remote', 'add', 'origin', origin)
  const store = createInstallStore(userData)
  const install = {
    id: 'demo',
    source: { kind: 'release' as const, repo: 'local/demo', path: 'demo', tag: 'v1', commit },
    manifest,
    setup: 'ok' as const,
  }
  await store.put(install)
  const consent = createConsentStore(join(userData, 'consent.json'))
  await consent.grant('demo', commit)
  const pin: PluginPin = { ...manifest, repo: 'local/demo', path: 'demo', commit }
  await writeFile(join(vaultA, pluginPinPath('demo')), JSON.stringify(pin))
  await writeFile(join(vaultB, pluginPinPath('demo')), JSON.stringify(pin))

  let endpoint: CliEndpoint | undefined
  let server: BridgeServer | undefined
  const bin = await installHoliCli(vaultA)
  const table = communityCapabilities({
    store,
    consent,
    supervisor: createSupervisor({ firstPort: 45600, onState() {}, frameOrigin: () => () => {} }),
    git: { url: () => origin, token: () => null },
    token: () => null,
    firstPartyIds: () => [],
    emit() {},
    bridgeScript: () => null,
    scratch: join(root, 'scratch'),
    checks: createChecks(),
    mutate: async (work) => work(),
  }) as Record<string, AnyCapability>
  const registry = createCapabilityRegistry()
  registry.register(COMMUNITY_NAMESPACES, table)
  const host = createCapabilityHost({
    registry,
    rootFor: async () => vaultA,
    active: () => null,
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  server = createBridgeServer({
    log() {},
    cli: {
      dispatch: host.dispatch,
      commands: (remote) => registry.commands(remote),
      rootFor: async () => vaultA,
      machine: {
        token: () => endpoint?.token ?? '',
        listVaults: async () => [
          { remote: 'owner/vault-a', name: 'vault-a', live: true },
          { remote: 'owner/vault-b', name: 'vault-b', live: true },
        ],
        resolveTarget: async (selector, cwd) => {
          const target = selector === 'owner/vault-b' ? vaultB : vaultA
          const canonical = await realpath(target)
          const physicalCwd = cwd === null ? null : await realpath(cwd).catch(() => cwd)
          const fromCwd = physicalCwd === null ? null : relative(canonical, physicalCwd)
          const cwdMatches =
            physicalCwd !== null &&
            isAbsolute(physicalCwd) &&
            (fromCwd === '' ||
              (fromCwd !== '..' && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd)))
          return selector === null && !cwdMatches
            ? null
            : {
                remote: selector === 'owner/vault-b' ? 'owner/vault-b' : 'owner/vault-a',
                root: canonical,
                live: true,
              }
        },
      },
    },
  })
  await server.start()
  endpoint = await publishCliEndpoint(join(vaultA, 'cli-endpoint.json'), server.port()!)
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' }

  return {
    root,
    vaultA,
    vaultB,
    bin,
    env,
    store,
    consent,
    async close() {
      await endpoint?.dispose()
      await server?.stop()
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await writeFile('/tmp/holi-522-cli-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`)
})

describe('community refresh-skills through the generated CLI and live bridge', () => {
  it('proves help, copy, no-op, conflict, force, JSON, strict flags and vault targeting', async () => {
    const f = await setup()
    const command = async (args: string[], cwd = f.vaultA) => {
      const result = await run(f.bin, args, cwd, f.env)
      evidence.push({
        command: ['holi', ...args],
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      })
      return result
    }
    try {
      const help = await command(['community', 'refresh-skills', '--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain(
        '--force replaces complete skill folders, including local edits',
      )

      const aPin = await readFile(join(f.vaultA, '.holi/plugins/demo/manifest.json'), 'utf8')
      const bPin = await readFile(join(f.vaultB, '.holi/plugins/demo/manifest.json'), 'utf8')
      const settingsA = await readFile(join(f.vaultA, '.holi/settings/plugins.yaml'), 'utf8')
      const first = await command(['community', 'refresh-skills', 'demo'])
      expect(first).toMatchObject({ code: 0, stdout: '.claude/skills/demo\n' })
      expect(await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        'pinned skill\n',
      )
      expect(await readFile(join(f.vaultA, '.claude/skills/demo/tool.bin'))).toEqual(
        Buffer.from([0, 1, 255]),
      )
      expect((await command(['community', 'refresh-skills', 'demo'])).code).toBe(0)
      expect(
        await writeFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'local edit\n'),
      ).toBeUndefined()
      const beforeConflict = await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')
      expect((await command(['community', 'refresh-skills', 'demo'])).code).not.toBe(0)
      expect(await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        beforeConflict,
      )
      expect((await command(['community', 'refresh-skills', 'demo', '--force'])).code).toBe(0)
      expect(await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        'pinned skill\n',
      )
      const json = await command(['community', 'refresh-skills', 'demo', '--json'])
      expect(json.code).toBe(0)
      expect(JSON.parse(json.stdout)).toEqual([])
      for (const args of [
        ['community', 'refresh-skills', 'demo', '--unknown'],
        ['community', 'refresh-skills', 'demo', '--force', '--force'],
        ['community', 'refresh-skills', 'demo', '--force=false'],
      ])
        expect((await command(args)).code).toBe(2)
      await mkdir(join(f.vaultB, '.claude/skills/demo'), { recursive: true })
      await writeFile(join(f.vaultB, '.claude/skills/demo/SKILL.md'), 'vault B local\n')
      await rm(join(f.vaultA, '.claude/skills/demo'), { recursive: true })
      const addressedAFromB = await command(
        ['community', 'refresh-skills', 'demo', '--vault=owner/vault-a'],
        f.vaultB,
      )
      expect(addressedAFromB.code).toBe(0)
      // Although execution starts from B, the explicit selector changes only A.
      expect(await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        'pinned skill\n',
      )
      expect(await readFile(join(f.vaultB, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
        'vault B local\n',
      )
      expect(await readFile(join(f.vaultA, '.holi/plugins/demo/manifest.json'), 'utf8')).toBe(aPin)
      expect(await readFile(join(f.vaultB, '.holi/plugins/demo/manifest.json'), 'utf8')).toBe(bPin)
      expect(await readFile(join(f.vaultA, '.holi/settings/plugins.yaml'), 'utf8')).toBe(settingsA)
      evidence.push({
        facts: {
          vaultA: {
            skill: await readFile(join(f.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8'),
            pinUnchanged:
              (await readFile(join(f.vaultA, '.holi/plugins/demo/manifest.json'), 'utf8')) === aPin,
            settingsUnchanged:
              (await readFile(join(f.vaultA, '.holi/settings/plugins.yaml'), 'utf8')) === settingsA,
          },
          vaultB: {
            skill: await readFile(join(f.vaultB, '.claude/skills/demo/SKILL.md'), 'utf8'),
            pinUnchanged:
              (await readFile(join(f.vaultB, '.holi/plugins/demo/manifest.json'), 'utf8')) === bPin,
          },
        },
      })
    } finally {
      await f.close()
    }
  })
})
