import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vaultSettings from '../../../main/vault/settings'
import type { PluginManifest, PluginPin } from '@holi/shared'
import type { CapabilityContext } from '../../../main/plugin-api'
import { communityCapabilities, listPlugins, seedRunningApps } from '../main/capabilities'
import { createChecks } from '../main/checks'
import { createConsentStore } from '../main/consent'
import { createInstallStore } from '../main/store'
import { createSupervisor } from '../main/supervisor'

const roots: string[] = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-folder-adoption-')))
  roots.push(root)
  const vault = join(root, 'vault')
  const userData = join(root, 'user')
  const folder = join(root, 'plugin')
  await mkdir(join(vault, '.holi/plugins/demo'), { recursive: true })
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await mkdir(folder, { recursive: true })
  const manifest: PluginManifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    opens: [],
    skills: [],
  }
  const alternate: PluginManifest = { ...manifest, version: '2.0.0' }
  const pin: PluginPin = {
    ...manifest,
    repo: 'owner/demo',
    path: '',
    commit: 'a'.repeat(40),
  }
  await writeFile(join(vault, '.holi/settings/plugins.yaml'), 'plugins:\n  demo: false\n')
  const pinPath = join(vault, '.holi/plugins/demo/manifest.json')
  await writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
  const store = createInstallStore(userData)
  await store.put({ id: 'demo', source: { kind: 'dev', folder }, manifest, setup: 'none' })
  const consent = createConsentStore(join(userData, 'consent.json'))
  let live = true
  let admitWork: (() => void) | null = null
  let holdAdmission = false
  const table = communityCapabilities({
    store,
    consent,
    supervisor: createSupervisor({ firstPort: 46801, onState() {}, frameOrigin: () => () => {} }),
    git: { url: () => '', token: () => null },
    token: () => null,
    firstPartyIds: () => [],
    emit() {},
    bridgeScript: () => null,
    scratch: join(root, 'scratch'),
    checks: createChecks(),
    mutate: async (work) => work(),
    admit: (work) => {
      if (!holdAdmission) return work()
      return new Promise((resolve, reject) => {
        admitWork = () => void work().then(resolve, reject)
      })
    },
    live: () => live,
  })
  const context = {
    root: vault,
    remote: 'owner/vault',
    bundle: null,
  } as unknown as CapabilityContext
  const call = async (name: 'community.list' | 'community.adoptFolder', params: unknown = {}) => {
    const capability = table[name] as unknown as {
      params(raw: unknown): unknown
      run(ctx: CapabilityContext, input: unknown): Promise<unknown>
    }
    return capability.run(context, capability.params(params))
  }
  return {
    root,
    vault,
    folder,
    manifest,
    alternate,
    pinPath,
    store,
    consent,
    call,
    setLive(value: boolean) {
      live = value
    },
    holdAdmission(value: boolean) {
      holdAdmission = value
    },
    admitted: () => admitWork,
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('folder adoption snapshot authorization', () => {
  it('seeds enabled dev-plugin apps without release setup state', async () => {
    const f = await fixture()
    await mkdir(join(f.folder, 'apps', 'Demo.app'), { recursive: true })
    await writeFile(join(f.folder, 'apps', 'Demo.app', 'index.html'), 'dev app')
    await rm(f.pinPath)
    const manifest = { ...f.manifest, apps: ['apps/Demo.app'] }
    await f.store.put({
      id: 'demo',
      source: { kind: 'dev', folder: f.folder },
      manifest,
      setup: 'none',
    })
    await writeFile(join(f.vault, '.holi/settings/plugins.yaml'), 'plugins:\n  demo: true\n')
    expect(await listPlugins(f.vault, { store: f.store, consent: f.consent })).toMatchObject([
      { id: 'demo', on: true, running: true, apps: ['apps/Demo.app'] },
    ])
    expect(await seedRunningApps(f.vault, { store: f.store, consent: f.consent })).toEqual([
      'Demo.app',
    ])
    expect(await readFile(join(f.vault, 'Demo.app/index.html'), 'utf8')).toBe('dev app')
  })

  it('rejects a displayed token after the folder install is replaced', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    expect(row).toMatchObject({ id: 'demo', install: { kind: 'dev' }, pin: { repo: 'owner/demo' } })
    expect(row.folderAdoptionToken).toBeTruthy()
    f.holdAdmission(true)
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    await f.store.put({
      id: 'demo',
      source: { kind: 'dev', folder: f.folder },
      manifest: f.alternate,
      setup: 'none',
    })
    f.admitted()?.()
    await expect(pending).rejects.toThrow(/changed/)
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
  })

  it('rejects a queued adoption after the original pin bytes change', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    f.holdAdmission(true)
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    await writeFile(f.pinPath, `${await readFile(f.pinPath, 'utf8')} `)
    f.admitted()?.()
    await expect(pending).rejects.toThrow(/changed/)
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
  })

  it('restores the pin after a settings write failure and allows retry', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    const write = vi
      .spyOn(vaultSettings, 'writeVaultSettings')
      .mockRejectedValueOnce(new Error('injected settings write failure'))
    await expect(
      f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken }),
    ).rejects.toThrow('injected settings write failure')
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
    await f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken })
    expect(await readFile(f.pinPath, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: true',
    )
    write.mockRestore()
  })

  it('checks lifetime inside queued settings publication and preserves concurrent edits', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const concurrent = vaultSettings.writeVaultSettings(
      f.vault,
      { committed: { plugins: { other: true } } },
      {
        beforeWrite: async () => {
          entered()
          await gate
        },
      },
    )
    await started
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    const rejected = expect(pending).rejects.toThrow(/attachment is closed/)
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(f.pinPath, 'utf8').catch(() => null)) === null) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await readFile(f.pinPath, 'utf8').catch(() => null)).toBeNull()
    f.setLive(false)
    release()
    await concurrent
    await rejected
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    const settings = await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')
    expect(settings).toContain('demo: false')
    expect(settings).toContain('other: true')
  })

  it('does not restore over a concurrent pin written during queued enablement', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const concurrent = vaultSettings.writeVaultSettings(
      f.vault,
      { committed: { plugins: { other: true } } },
      {
        beforeWrite: async () => {
          entered()
          await gate
        },
      },
    )
    await started
    const replacement = `${await readFile(f.pinPath, 'utf8')} `
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    const rejected = expect(pending).rejects.toThrow(/changed/)
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(f.pinPath, 'utf8').catch(() => null)) === null) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await readFile(f.pinPath, 'utf8').catch(() => null)).toBeNull()
    await mkdir(join(f.vault, '.holi/plugins/demo'), { recursive: true })
    await writeFile(f.pinPath, replacement)
    release()
    await concurrent
    await rejected
    expect(await readFile(f.pinPath, 'utf8')).toBe(replacement)
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'other: true',
    )
  })

  it('restores the pin when its owner closes immediately after unpin', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    const get = f.store.get.bind(f.store)
    const closeAfterUnpin = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      const install = await get(id)
      if ((await readFile(f.pinPath, 'utf8').catch(() => null)) === null) f.setLive(false)
      return install
    })
    await expect(
      f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken }),
    ).rejects.toThrow(/attachment is closed/)
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )

    closeAfterUnpin.mockRestore()
    f.setLive(true)
    await f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken })
    expect(await readFile(f.pinPath, 'utf8').catch(() => null)).toBeNull()
  })

  it('restores the pin when the owner closes during final settings publication', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    const write = vaultSettings.writeVaultSettings
    let publicationStarted!: () => void
    let releasePublication!: () => void
    const started = new Promise<void>((resolve) => (publicationStarted = resolve))
    const gate = new Promise<void>((resolve) => (releasePublication = resolve))
    let guardCalls = 0
    const spy = vi
      .spyOn(vaultSettings, 'writeVaultSettings')
      .mockImplementation(async (root, settings, options) =>
        write(root, settings, {
          beforeWrite: async () => {
            guardCalls++
            if (guardCalls === 2) {
              publicationStarted()
              await gate
            }
            await options?.beforeWrite?.()
          },
        }),
      )
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    await started
    f.setLive(false)
    releasePublication()
    await expect(pending).rejects.toThrow(/attachment is closed/)
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
    expect(
      await readFile(join(f.vault, '.holi/settings/plugins.yaml.tmp'), 'utf8').catch(() => null),
    ).toBeNull()

    spy.mockRestore()
    f.setLive(true)
    await f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken })
    expect(await readFile(f.pinPath, 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: true',
    )
  })

  it('does not publish over a pin replaced during final settings publication', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    const write = vaultSettings.writeVaultSettings
    let publicationStarted!: () => void
    let releasePublication!: () => void
    const started = new Promise<void>((resolve) => (publicationStarted = resolve))
    const gate = new Promise<void>((resolve) => (releasePublication = resolve))
    let guardCalls = 0
    const spy = vi
      .spyOn(vaultSettings, 'writeVaultSettings')
      .mockImplementation(async (root, settings, options) =>
        write(root, settings, {
          beforeWrite: async () => {
            guardCalls++
            if (guardCalls === 2) {
              publicationStarted()
              await gate
            }
            await options?.beforeWrite?.()
          },
        }),
      )
    const originalPin = await readFile(f.pinPath, 'utf8')
    const pending = f.call('community.adoptFolder', {
      id: 'demo',
      token: row.folderAdoptionToken,
    })
    await started
    const replacement = `${originalPin} `
    await mkdir(join(f.vault, '.holi/plugins/demo'), { recursive: true })
    await writeFile(f.pinPath, replacement)
    releasePublication()
    await expect(pending).rejects.toThrow(/folder installation changed during adoption/)
    expect(await readFile(f.pinPath, 'utf8')).toBe(replacement)
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
    expect(
      await readFile(join(f.vault, '.holi/settings/plugins.yaml.tmp'), 'utf8').catch(() => null),
    ).toBeNull()
    spy.mockRestore()
  })

  it('does not publish or enable when its attachment closes before admission', async () => {
    const f = await fixture()
    const row = (
      (await f.call('community.list')) as { id: string; folderAdoptionToken: string }[]
    )[0]!
    expect(row.folderAdoptionToken).toBeTruthy()
    f.holdAdmission(true)
    const pending = f.call('community.adoptFolder', { id: 'demo', token: row.folderAdoptionToken })
    f.setLive(false)
    f.admitted()?.()
    await expect(pending).rejects.toThrow(/attachment is closed/)
    expect(await readFile(f.pinPath, 'utf8')).toContain('owner/demo')
    expect(await readFile(join(f.vault, '.holi/settings/plugins.yaml'), 'utf8')).toContain(
      'demo: false',
    )
  })
})
