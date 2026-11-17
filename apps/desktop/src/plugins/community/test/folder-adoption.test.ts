import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest, PluginPin } from '@holi/shared'
import type { CapabilityContext } from '../../../main/plugin-api'
import { communityCapabilities } from '../main/capabilities'
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

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

describe('folder adoption snapshot authorization', () => {
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
