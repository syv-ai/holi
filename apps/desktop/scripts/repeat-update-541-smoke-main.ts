import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { pathToFileURL } from 'node:url'
import { registerIpc, createRendererFlushChannel } from '../src/main/ipc'
import { requestFlush } from '../src/main/flush'
import { isApplicationSender } from '../src/main/application-sender'

// Package/distribution and download/install are controlled. Candidate selection
// and Holi's updater are real; this does not exercise native bundle replacement.
async function run(): Promise<void> {
  const config = JSON.parse(await readFile(process.argv.at(-1)!, 'utf8')) as {
    root: string
    feed: string
    expected: string | null
    install: boolean
    consent: boolean
    prompt: boolean
    action: 'account' | 'dialog'
    result: string
  }
  assert(resolve(config.root) === config.root)
  assert(new URL(config.feed).hostname === '127.0.0.1')
  for (const name of ['userData', 'sessionData'] as const) {
    const path = join(config.root, name)
    await mkdir(path, { recursive: true })
    app.setPath(name, path)
    assert.equal(app.getPath(name), path)
  }
  Object.defineProperty(app, 'isPackaged', { value: true })
  await writeFile(
    join(config.root, 'userData', 'updates.json'),
    JSON.stringify({ enabled: true, channel: 'dev' }),
  )
  await app.whenReady()
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  autoUpdater.setFeedURL({ provider: 'generic', url: config.feed })
  let offered: unknown = null
  let installs = 0
  let guards = 0
  let flushed = false
  autoUpdater.on('update-available', (info) => {
    offered = { version: info.version, releaseDate: info.releaseDate }
  })
  autoUpdater.downloadUpdate = async () => {
    // A download adapter must still deliver the real selected candidate.
    assert(offered)
    autoUpdater.emit('update-downloaded', offered)
    return []
  }
  autoUpdater.quitAndInstall = () => {
    installs += 1
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    callback({
      cancel:
        !['file:', 'data:'].includes(url.protocol) && url.origin !== new URL(config.feed).origin,
    })
  })
  const entry = join(app.getAppPath(), 'renderer', 'index.html')
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 650,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(app.getAppPath(), 'preload.cjs'),
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const authorize = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    isApplicationSender(event, window.webContents, pathToFileURL(entry).href)
  ipcMain.handle('window:is-visible', (event) => authorize(event))
  const { createUpdater } = await import('../src/main/updates/updater')
  const statuses: unknown[] = []
  const updater = createUpdater({
    send: (status) => {
      statuses.push(status)
      if (!window.isDestroyed()) window.webContents.send('updates:status', status)
    },
    beforeInstall: async () => {
      guards += 1
      if (!config.consent) return false
      flushed = (await requestFlush(createRendererFlushChannel(window, authorize))) === 'flushed'
      return flushed
    },
    installFailed: (message) => {
      throw new Error(message)
    },
  })
  const { createRouter } = await import('../src/main/router')
  const router = createRouter({
    registry: { list: async () => [] },
    host: { active: () => null },
    plugins: { scanClaimsFor: async () => [] },
    session: { api: {}, onGenerationChange: () => () => {} },
    vaultRoot: join(config.root, 'vaults'),
    updates: updater,
    openExternal: async () => {
      throw new Error('External navigation is not allowed')
    },
  } as never)
  registerIpc({ router, rootFor: async () => null, authorizeSender: authorize })
  async function waitFor(expression: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!(await window.webContents.executeJavaScript(`Boolean(${expression})`))) {
      assert(Date.now() < deadline, `Renderer did not reach: ${expression}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  try {
    await window.loadFile(entry)
    await waitFor('document.querySelector("[aria-label^=\\"Account menu\\"]")')
    // The post-upgrade observation uses Holi's actual startup background timer,
    // not a user-triggered check or a manufactured post-restart status.
    if (config.expected === null) {
      const deadline = Date.now() + 15_000
      while (updater.status().lastCheckAt === null || updater.status().state === 'checking') {
        assert(Date.now() < deadline, 'Startup background update check did not settle')
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
    const status = config.expected === null ? updater.status() : await updater.check()
    assert.equal(status.lastError, null)
    assert.equal(status.availableVersion, config.expected)
    assert.equal(status.state, config.expected === null ? 'idle' : 'ready')
    if (config.expected !== null) {
      await waitFor('document.querySelector("[data-update-dot]")')
      if (config.prompt) await waitFor('document.querySelector("[role=alertdialog]")')
      if (config.install) {
        if (config.action === 'dialog') {
          await window.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Restart now').click()`,
          )
        } else {
          if (config.prompt) {
            await window.webContents.executeJavaScript(
              `Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Later').click()`,
            )
            await waitFor('!document.querySelector("[role=alertdialog]")')
          }
          await window.webContents.executeJavaScript(
            `document.querySelector('[aria-label^="Account menu"]').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,button:0,ctrlKey:false}))`,
          )
          await waitFor('document.querySelector("[role=menuitem]")')
          await window.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.includes('Restart to update')).click()`,
          )
        }

        const deadline = Date.now() + 5_000
        while (guards === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        while (config.consent && installs === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(
        await window.webContents.executeJavaScript(
          'document.querySelector("[role=alertdialog]") === null && document.querySelector("[data-update-dot]") === null',
        ),
        true,
      )
    }
    const installed = installs !== 0
    assert.equal(installed, config.install && config.consent && config.expected !== null)
    assert.equal(installs, installed ? 1 : 0)
    assert.equal(guards, config.install && config.expected !== null ? 1 : 0)
    assert.equal(flushed, installed)
    await writeFile(config.result + '.png', (await window.capturePage()).toPNG())
    await writeFile(
      config.result,
      JSON.stringify({
        ok: true,
        electron: process.versions.electron,
        running: app.getVersion(),
        offered,
        status,
        statuses,
        installed,
        installs,
        guards,
        flushed,
        simulation: 'package flag, download and installer; no native bundle replacement',
      }),
    )
  } finally {
    updater.dispose()
    window.destroy()
  }
}

run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  },
)
