import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

async function fingerprint(path: string): Promise<string> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 'absent'
  if (info.isSymbolicLink()) return `link:${await readFile(path).catch(() => Buffer.from(''))}`
  if (info.isFile())
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  if (!info.isDirectory()) return `special:${info.mode}`
  const entries = await Promise.all(
    (await readdir(path))
      .sort()
      .map(async (name) => `${name}:${await fingerprint(join(path, name))}`),
  )
  return createHash('sha256').update(entries.join('\\n')).digest('hex')
}

async function captureFacts(f: { vaultA: string; vaultB: string; root: string }) {
  const vault = async (root: string) => ({
    pin: await fingerprint(join(root, '.holi/plugins/demo/manifest.json')),
    settings: await fingerprint(join(root, '.holi/settings/plugins.yaml')),
    consent: await fingerprint(join(f.root, 'user/consent.json')),
    apps: await fingerprint(join(root, 'demo.app')),
    gitignore: await fingerprint(join(root, '.gitignore')),
    commandLinks: await fingerprint(join(root, '.holi/bin')),
    otherSkills: await fingerprint(join(root, '.claude/skills/other')),
  })
  return { vaultA: await vault(f.vaultA), vaultB: await vault(f.vaultB) }
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
    await mkdir(join(vault, '.claude/skills/other'), { recursive: true })
    await writeFile(join(vault, '.claude/skills/other/SKILL.md'), 'unchanged skill\n')
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
    rootFor: async (remote) =>
      remote === 'owner/vault-a' ? vaultA : remote === 'owner/vault-b' ? vaultB : null,
    active: () => ({
      remote: 'owner/vault-b',
      root: vaultB,
      snapshot: () => ({ files: [] }) as never,
      refresh: async () => undefined,
    }),
    core: noCoreServices,
    pluginEnabled: async () => true,
    claims: async () => [],
  })
  server = createBridgeServer({
    log() {},
    cli: {
      dispatch: host.dispatch,
      commands: (remote) => registry.commands(remote),
      rootFor: async (remote) =>
        remote === 'owner/vault-a' ? vaultA : remote === 'owner/vault-b' ? vaultB : null,
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

describe('community refresh-skills through the generated CLI and live bridge', () => {
  let f: Awaited<ReturnType<typeof setup>> | undefined
  let before: Awaited<ReturnType<typeof captureFacts>>

  beforeEach(async () => {
    f = await setup()
    before = await captureFacts(f)
  })

  afterEach(async () => {
    try {
      // Every scenario must leave unrelated vault and install state untouched.
      if (f) expect(await captureFacts(f)).toEqual(before)
    } finally {
      try {
        await f?.close()
      } finally {
        f = undefined
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
      }
    }
  })

  function command(args: string[], cwd = f!.vaultA) {
    return run(f!.bin, ['community', 'refresh-skills', ...args], cwd, f!.env)
  }

  it('explains force replacement in help', async () => {
    const help = await command(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--force replaces complete skill folders, including local edits')
  })

  it('copies pinned text and binary skills, then reports a JSON no-op', async () => {
    const first = await command(['demo'])
    expect(first).toMatchObject({ code: 0, stdout: '.claude/skills/demo\n' })
    expect(await readFile(join(f!.vaultA, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe(
      'pinned skill\n',
    )
    expect(await readFile(join(f!.vaultA, '.claude/skills/demo/tool.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    )
    const copied = await fingerprint(join(f!.vaultA, '.claude/skills/demo'))
    expect((await command(['demo'])).code).toBe(0)
    const json = await command(['demo', '--json'])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual([])
    expect(await fingerprint(join(f!.vaultA, '.claude/skills/demo'))).toBe(copied)
  })

  it('preserves conflicting local edits unless force is explicit', async () => {
    const skill = join(f!.vaultA, '.claude/skills/demo')
    await mkdir(skill, { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), 'local edit\n')
    await writeFile(join(skill, 'local.txt'), 'local extra\n')
    const edited = await fingerprint(skill)
    expect((await command(['demo'])).code).not.toBe(0)
    expect(await fingerprint(skill)).toBe(edited)
    expect((await command(['demo', '--force'])).code).toBe(0)
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('pinned skill\n')
    expect((await readdir(skill)).sort()).toEqual(['SKILL.md', 'tool.bin'])
  })

  it.each([['--unknown'], ['--force', '--force'], ['--force=false']])(
    'rejects strict flag violation %j without copying skills',
    async (...flags) => {
      expect((await command(['demo', ...flags])).code).toBe(2)
      expect(await fingerprint(join(f!.vaultA, '.claude/skills/demo'))).toBe('absent')
      expect(await fingerprint(join(f!.vaultB, '.claude/skills/demo'))).toBe('absent')
    },
  )

  it('targets only the explicit vault, not cwd or the active vault', async () => {
    const bSkill = join(f!.vaultB, '.claude/skills/demo/SKILL.md')
    await mkdir(join(f!.vaultB, '.claude/skills/demo'), { recursive: true })
    await writeFile(bSkill, 'vault B local\n')
    const addressedAFromB = await command(['demo', '--vault=owner/vault-a'], f!.vaultB)
    expect(addressedAFromB.code).toBe(0)
    const aSkill = join(f!.vaultA, '.claude/skills/demo/SKILL.md')
    expect(await readFile(aSkill, 'utf8')).toBe('pinned skill\n')
    expect(await readFile(bSkill, 'utf8')).toBe('vault B local\n')
    const aBeforeB = await fingerprint(join(f!.vaultA, '.claude/skills/demo'))
    const addressedB = await command(['demo', '--force', '--vault=owner/vault-b'], f!.vaultA)
    expect(addressedB.code).toBe(0)
    expect(await readFile(bSkill, 'utf8')).toBe('pinned skill\n')
    expect(await fingerprint(join(f!.vaultA, '.claude/skills/demo'))).toBe(aBeforeB)
  })
})
