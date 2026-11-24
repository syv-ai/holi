import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { app } from 'electron'

// Package/distribution and download/install are controlled. Candidate selection
// and Holi's updater are real; this does not exercise native bundle replacement.
async function run(): Promise<void> {
  const config = JSON.parse(await readFile(process.argv.at(-1)!, 'utf8')) as {
    root: string
    feed: string
    expected: string | null
    install: boolean
    consent: boolean
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
  const { createUpdater } = await import('../src/main/updates/updater')
  const statuses: unknown[] = []
  const updater = createUpdater({
    send: (status) => statuses.push(status),
    beforeInstall: async () => config.consent,
    installFailed: (message) => {
      throw new Error(message)
    },
  })
  try {
    const status = await updater.check()
    assert.equal(status.lastError, null)
    assert.equal(status.availableVersion, config.expected)
    assert.equal(status.state, config.expected === null ? 'idle' : 'ready')
    const installed = config.install ? await updater.install() : false
    assert.equal(installed, config.install && config.consent && config.expected !== null)
    assert.equal(installs, installed ? 1 : 0)
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
        simulation: 'package flag, download and installer; no native bundle replacement',
      }),
    )
  } finally {
    updater.dispose()
  }
}

run().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  },
)
