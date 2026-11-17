import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInstallStore } from '../src/plugins/community/main/store'
import { createConsentStore } from '../src/plugins/community/main/consent'
import { createSupervisor } from '../src/plugins/community/main/supervisor'
import { createChecks } from '../src/plugins/community/main/checks'
import { communityCapabilities } from '../src/plugins/community/main/capabilities'
import type { CapabilityContext } from '../src/main/capabilities/registry'

const root = process.env.HOLI_510_ROOT!
const repo = process.env.HOLI_510_REPO!
const userData = join(root, 'profile')
const vault = join(root, 'vault')
const remote = 'native-community-smoke'

async function main() {
  app.setPath('userData', userData)
  app.setPath('sessionData', join(root, 'session'))
  await app.whenReady()
  await mkdir(join(vault, 'slides.md'), { recursive: true }).catch(() => undefined)
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await writeFile(join(vault, '.holi/settings/plugins.yaml'), 'plugins:\n  community: true\n  smoke-plugin: true\n')
  await writeFile(join(vault, 'slides.md'), '# Native community hint fixture\n')
  const store = createInstallStore(userData)
  const consent = createConsentStore(join(userData, 'plugin-consent.json'))
  const supervisor = createSupervisor({ firstPort: 47100, onState: (_key, state) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('community-state', state)
  } })
  const deps = {
    store, consent, supervisor, git: { url: () => repo, token: () => null },
    token: () => null, firstPartyIds: () => ['agent', 'pdf'],
    emit: (_remote: string, name: string, payload: unknown) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(`community:${name}`, payload)
    }, bridgeScript: () => process.env.HOLI_BRIDGE_SCRIPT ?? null,
    scratch: join(userData, 'plugins/.staging'), checks: createChecks(),
    mutate: async <T>(work: () => Promise<T>) => work(), searchPath: () => '',
  }
  const table = communityCapabilities(deps)
  const ctx = { remote, root: vault, bundle: null } as unknown as CapabilityContext
  const call = async (name: string, params: unknown = {}) => {
    const capability = (table as any)[name]
    return capability.run(ctx, capability.params(params))
  }
  ipcMain.handle('community:call', (_event, name: string, params: unknown) => call(name, params))
  await call('community.install', { repo: 'syv-ai/smoke-plugin', path: '', version: '0.1.0', expectId: 'smoke-plugin' })
  const installed = await store.get('smoke-plugin')
  if (!installed || installed.source.kind !== 'release') throw new Error('fixture install absent')
  await call('community.consent', { id: 'smoke-plugin', commit: installed.source.commit })
  if (!(await call('community.setup', { id: 'smoke-plugin' }))) throw new Error('fixture setup failed')
  await call('community.pin', { id: 'smoke-plugin' })
  const window = new BrowserWindow({ width: 1100, height: 760, webPreferences: {
    preload: join(root, 'preload.cjs'), contextIsolation: true, sandbox: true,
    nodeIntegration: false, webSecurity: true,
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.loadFile(join(root, 'renderer/index.html'))
  ipcMain.on('smoke:quit', () => { void supervisor.stopAll(); app.quit() })
}

void main().catch((error) => { console.error(error); app.exit(1) })
