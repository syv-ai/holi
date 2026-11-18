import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInstallStore } from '../src/plugins/community/main/store'
import { createConsentStore } from '../src/plugins/community/main/consent'
import { createSupervisor } from '../src/plugins/community/main/supervisor'
import { createChecks } from '../src/plugins/community/main/checks'
import { communityCapabilities } from '../src/plugins/community/main/capabilities'
import bridgeAsset from '../src/plugins/community/shared/hint-bridge.js?asset&asarUnpack'
import type { CapabilityContext } from '../src/main/capabilities/registry'

const root = process.env.HOLI_510_ROOT!
const userData = join(root, 'profile')
const vault = join(root, 'vault')
const remote = 'syv-ai/native-community-smoke'
app.setPath('userData', userData)
app.setPath('sessionData', join(root, 'session'))
let shutdown: (() => Promise<void>) | undefined
let exiting = false
app.on('before-quit', (event) => {
  if (exiting) return
  event.preventDefault()
  exiting = true
  void shutdown?.().finally(() => app.exit())
})

async function main() {
  await app.whenReady()
  const { session } = await import('electron')
  session.defaultSession.webRequest.onBeforeRequest((details, answer) => {
    const url = new URL(details.url)
    answer({
      cancel:
        !['file:', 'data:'].includes(url.protocol) &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)),
    })
  })
  await mkdir(join(vault, '.holi/settings'), { recursive: true })
  await writeFile(
    join(vault, '.holi/settings/plugins.yaml'),
    'plugins:\n  community: true\n  smoke-plugin: true\n',
  )
  await writeFile(join(vault, 'slides.md'), '# Native community hint fixture\n')
  const store = createInstallStore(userData)
  const consent = createConsentStore(join(userData, 'plugin-consent.json'))
  const checks = createChecks()
  const supervisor = createSupervisor({
    firstPort: Number(process.env.HOLI_510_SERVER_PORT),
    onState: () => undefined,
    frameOrigin: () => () => undefined,
  })
  shutdown = async () => {
    await checks.stop()
    await supervisor.stopAll()
  }
  const table = communityCapabilities({
    store,
    consent,
    supervisor,
    git: { url: () => join(root, 'plugin'), token: () => null },
    token: () => null,
    firstPartyIds: () => ['agent', 'pdf'],
    emit: () => undefined,
    bridgeScript: () => bridgeAsset,
    scratch: join(userData, 'plugins/.staging'),
    checks,
    mutate: async <T>(work: () => Promise<T>) => work(),
    searchPath: () => '',
  })
  const ctx = { remote, root: vault, bundle: null } as unknown as CapabilityContext
  const call = async (name: string, params: unknown = {}) => {
    if (!(name in table)) throw new Error('unknown fixture capability')
    const entry = table[name as keyof typeof table]
    return entry.run(ctx, entry.params(params) as never)
  }
  await call('community.install', { repo: 'syv-ai/smoke-plugin', path: '', version: '0.1.0' })
  let row = ((await call('community.list')) as { status: string }[])[0]
  if (row?.status !== 'needs-consent') throw new Error('fixture did not require consent')
  const installed = await store.get('smoke-plugin')
  if (!installed || installed.source.kind !== 'release') throw new Error('fixture install absent')
  await call('community.consent', { id: 'smoke-plugin', commit: installed.source.commit })
  if (!(await call('community.setup', { id: 'smoke-plugin' })))
    throw new Error('fixture setup failed')
  if (
    (await readFile(join(store.codeDir(installed), '.hint-smoke-setup'), 'utf8')) !==
    'setup-complete'
  )
    throw new Error('fixture setup marker absent')
  await call('community.pin', { id: 'smoke-plugin' })
  row = ((await call('community.list')) as { status: string }[])[0]
  if (row?.status !== 'ready') throw new Error('fixture did not become ready')
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  ipcMain.handle('community:call', async (event, name: string, params: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('foreign fixture sender')
    return call(name, params)
  })
  ipcMain.handle(
    'community:trpc',
    async (
      event,
      op: { path: string; input: { name?: string; remote?: string; paramsJson?: string } },
    ) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return { ok: false, message: 'foreign fixture sender' }
      if (op.path !== 'cap.run' || op.input.remote !== remote || !op.input.name)
        return { ok: false, message: 'unsupported fixture operation' }
      try {
        return {
          ok: true,
          data: await call(
            op.input.name,
            op.input.paramsJson ? JSON.parse(op.input.paramsJson) : {},
          ),
        }
      } catch (error) {
        return { ok: false, message: String(error) }
      }
    },
  )
  ipcMain.on('smoke:quit', (event) => {
    if (event.sender === window.webContents) app.quit()
  })
  await window.loadFile(join(root, 'renderer/scripts/community-hints-native-smoke.html'))
}
void main().catch(async (error) => {
  console.error(error)
  await shutdown?.()
  app.exit(1)
})
