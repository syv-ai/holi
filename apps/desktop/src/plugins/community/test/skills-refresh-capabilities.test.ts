import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginPinPath, type PluginManifest, type PluginPin } from '@holi/shared'
import type { CapabilityContext } from '../../../main/plugin-api'
import { communityCapabilities } from '../main/capabilities'
import { createChecks } from '../main/checks'
import { createConsentStore } from '../main/consent'
import { createInstallStore } from '../main/store'
import { createSupervisor } from '../main/supervisor'
import { validateSkillSnapshot } from '../main/skill-release'
import { refreshSkills } from '../main/skills'

const roots: string[] = []
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function fixture(path = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-522-provenance-')))
  roots.push(root)
  const vault = join(root, 'vault')
  const userData = join(root, 'user')
  let releaseDir = join(userData, 'plugins', 'demo', 'release')
  let pluginDir = path ? join(releaseDir, path) : releaseDir
  await mkdir(pluginDir, { recursive: true })
  await mkdir(join(vault, '.holi/plugins/demo'), { recursive: true })
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await writeFile(join(vault, '.holi/settings/plugins.yaml'), 'plugins:\n  demo: true\n')
  const skillPath = 'skills/demo'
  await mkdir(join(pluginDir, skillPath), { recursive: true })
  await writeFile(join(pluginDir, skillPath, 'SKILL.md'), 'pinned\n')
  await writeFile(join(pluginDir, skillPath, 'tool.bin'), Buffer.from([0, 1, 255, 10]))
  await writeFile(join(pluginDir, skillPath, 'run.sh'), '#!/bin/sh\ntrue\n')
  await chmod(join(pluginDir, skillPath, 'run.sh'), 0o755)
  const manifest: PluginManifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    opens: [],
    skills: [skillPath],
  }
  await writeFile(join(pluginDir, 'holi-plugin.json'), JSON.stringify(manifest))
  sh(releaseDir, 'init', '-q', '-b', 'main')
  sh(releaseDir, 'add', '.')
  sh(
    releaseDir,
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@example.test',
    'commit',
    '-qm',
    'release',
  )
  const commit = sh(releaseDir, 'rev-parse', 'HEAD')
  const installedRelease = join(userData, 'plugins', 'demo', commit)
  await rename(releaseDir, installedRelease)
  releaseDir = installedRelease
  pluginDir = path ? join(releaseDir, path) : releaseDir
  const origin = join(root, 'origin.git')
  sh(releaseDir, 'remote', 'add', 'origin', origin)
  const store = createInstallStore(userData)
  const install = {
    id: 'demo',
    source: { kind: 'release' as const, repo: 'local/demo', path, tag: 'v1', commit },
    manifest,
    setup: 'ok' as const,
  }
  await store.put(install)
  const consent = createConsentStore(join(userData, 'consent.json'))
  await consent.grant('demo', commit)
  const pin: PluginPin = { ...manifest, repo: 'local/demo', path, commit }
  await writeFile(join(vault, pluginPinPath('demo')), JSON.stringify(pin))
  const context = {
    root: vault,
    remote: 'owner/vault',
    bundle: null,
  } as unknown as CapabilityContext
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
  })
  const capability = table['community.refresh-skills'] as unknown as {
    params(raw: unknown): unknown
    run(ctx: CapabilityContext, params: unknown): Promise<string[]>
  }
  const call = (force = false) => capability.run(context, capability.params({ id: 'demo', force }))
  return {
    root,
    vault,
    releaseDir,
    pluginDir,
    skillPath,
    manifest,
    commit,
    origin,
    store,
    consent,
    call,
  }
}

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

describe('pinned refresh authorization', () => {
  it.each(['', 'demo'])('refreshes source path %s from full-tree Git objects', async (path) => {
    const f = await fixture(path)
    await expect(f.call()).resolves.toEqual(['.claude/skills/demo'])
    expect(await readFile(join(f.vault, '.claude/skills/demo/tool.bin'))).toEqual(
      Buffer.from([0, 1, 255, 10]),
    )
    expect((await stat(join(f.vault, '.claude/skills/demo/run.sh'))).mode & 0o777).toBe(0o755)
  })

  it('rejects altered detached snapshot bytes before publication even if checkout bytes are restored', async () => {
    const f = await fixture()
    await expect(
      refreshSkills(f.manifest, f.pluginDir, f.vault, {
        force: true,
        guard() {},
        async validateSnapshot(snapshots) {
          const altered = snapshots.map((snapshot) => ({
            ...snapshot,
            files: snapshot.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
          }))
          altered[0]!.files.find((file) => file.path === 'SKILL.md')!.bytes = Buffer.from('altered')
          await writeFile(join(f.pluginDir, f.skillPath, 'SKILL.md'), 'temporary edit')
          await writeFile(join(f.pluginDir, f.skillPath, 'SKILL.md'), 'pinned\n')
          expect(() =>
            validateSkillSnapshot(f.releaseDir, f.commit, '', f.manifest.skills!, altered),
          ).toThrow(/pinned bytes/)
          throw new Error('pinned bytes rejected')
        },
      }),
    ).rejects.toThrow('pinned bytes rejected')
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
  })

  it('validates contained symlink content against the target blob', async () => {
    const f = await fixture()
    await writeFile(join(f.pluginDir, 'shared.md'), 'target\n')
    await symlink('../../shared.md', join(f.pluginDir, f.skillPath, 'link.md'))
    sh(f.releaseDir, 'add', '.')
    sh(
      f.releaseDir,
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=ada@example.test',
      'commit',
      '-qm',
      'symlink',
    )
    const commit = sh(f.releaseDir, 'rev-parse', 'HEAD')
    await expect(
      refreshSkills(f.manifest, f.pluginDir, f.vault, {
        force: true,
        guard() {},
        validateSnapshot: (snapshot) =>
          validateSkillSnapshot(f.releaseDir, commit, '', f.manifest.skills!, snapshot),
      }),
    ).resolves.toEqual(['.claude/skills/demo'])
    expect(await readFile(join(f.vault, '.claude/skills/demo/link.md'), 'utf8')).toBe('target\n')
  })

  it('refuses a competing vault pin even with force before publishing', async () => {
    const f = await fixture()
    await mkdir(join(f.vault, '.holi/plugins/other'), { recursive: true })
    await writeFile(
      join(f.vault, '.holi/plugins/other/manifest.json'),
      JSON.stringify({
        id: 'other',
        name: 'Other',
        version: '1.0.0',
        opens: [],
        skills: ['skills/demo'],
        repo: 'local/other',
        path: '',
        commit: f.commit,
      }),
    )
    await expect(f.call(true)).rejects.toThrow(/claimed/)
    await expect(readFile(join(f.vault, '.claude/skills/demo/SKILL.md'))).rejects.toThrow()
  })

  it('rejects altered working-tree source bytes and manifest bytes', async () => {
    const f = await fixture()
    await writeFile(join(f.pluginDir, f.skillPath, 'tool.bin'), Buffer.from([9]))
    await expect(f.call()).rejects.toThrow(/pinned bytes/)
    await writeFile(join(f.pluginDir, f.skillPath, 'tool.bin'), Buffer.from([0, 1, 255, 10]))
    await writeFile(
      join(f.pluginDir, 'holi-plugin.json'),
      JSON.stringify({ ...f.manifest, version: '2.0.0' }),
    )
    await expect(f.call()).rejects.toThrow(/checkout does not match its pin/)
  })

  it('rejects pin metadata, HEAD, and origin mismatches', async () => {
    const f = await fixture()
    const pinPath = join(f.vault, pluginPinPath('demo'))
    await writeFile(
      pinPath,
      JSON.stringify({ ...f.manifest, repo: 'wrong/repo', path: '', commit: f.commit }),
    )
    await expect(f.call()).rejects.toThrow(/complete pin/)
    await writeFile(
      pinPath,
      JSON.stringify({ ...f.manifest, repo: 'local/demo', path: '', commit: 'f'.repeat(40) }),
    )
    await expect(f.call()).rejects.toThrow(/complete pin/)
    await writeFile(
      pinPath,
      JSON.stringify({ ...f.manifest, repo: 'local/demo', path: '', commit: f.commit }),
    )
    await writeFile(join(f.pluginDir, 'untracked.txt'), 'commit change')
    sh(f.releaseDir, 'add', '.')
    sh(
      f.releaseDir,
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=ada@example.test',
      'commit',
      '-qm',
      'changed head',
    )
    await expect(f.call()).rejects.toThrow(/checkout does not match its pin/)
    sh(f.releaseDir, 'checkout', '-q', f.commit)
    sh(f.releaseDir, 'config', 'remote.origin.url', join(f.root, 'wrong-origin'))
    await expect(f.call()).rejects.toThrow(/checkout does not match its pin/)
  })

  it('rejects dev, unapproved, unready, disabled, and unsafe pin states', async () => {
    const f = await fixture()
    await rm(join(f.vault, pluginPinPath('demo')))
    await symlink(join(f.root, 'missing'), join(f.vault, pluginPinPath('demo')))
    await expect(f.call()).rejects.toThrow(/safe release pin/)
    await rm(join(f.vault, pluginPinPath('demo')))
    await writeFile(
      join(f.vault, pluginPinPath('demo')),
      JSON.stringify({ ...f.manifest, repo: 'local/demo', path: '', commit: f.commit }),
    )
    await f.consent.forget('demo')
    await expect(f.call()).rejects.toThrow(/consented/)
    await f.consent.grant('demo', f.commit)
    const install = await f.store.get('demo')
    await f.store.put({ ...install!, setup: 'none' })
    await expect(f.call()).rejects.toThrow(/setup-ready/)
    await f.store.put({ ...install!, source: { kind: 'dev', folder: f.pluginDir } })
    await expect(f.call()).rejects.toThrow(/installed release/)
  })
})
